<?php

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Server-side Pele (Mermaid -> SVG/PNG) integration for BookStack page content.
 *
 * Transformation happens at display/export view-render time (via theme view
 * overrides of "pages.parts.page-display" and "exports.parts.page-item"), which
 * is after all BookStack content filtering has taken place. This keeps stored
 * page HTML clean, and ensures rendered output reaches web pages, HTML exports
 * and the PDF (dompdf) engine intact.
 *
 * The heavy lifting is delegated to the "pele-render" sidecar service, with
 * rendered output cached per source + mode so the sidecar is only contacted
 * when diagram content changes.
 */
class PeleTheme
{
    /** Bump to invalidate cached renders and asset URLs (keep in sync with bookstack-module.json). */
    public const VERSION = '1.1.0';

    protected const CACHE_PREFIX = 'pele-render:';
    protected const CACHE_DAYS = 30;
    protected const MAX_BLOCKS = 100;

    protected const CODE_BLOCK_PATTERN = '/<pre[^>]*>\s*<code[^>]*class="[^"]*\blanguage-mermaid\b[^"]*"[^>]*>(.*?)<\/code>\s*<\/pre>/si';

    /**
     * Transform any Pele code blocks within the given page HTML into rendered diagrams.
     *
     * @param string $html   Rendered page content HTML.
     * @param string $format Render format: "web" (default), "html" or "pdf".
     */
    public static function transformPageHtml(string $html, string $format = 'web'): string
    {
        if ($html === '' || stripos($html, 'language-mermaid') === false) {
            return $html;
        }

        $mode = self::modeFromFormat($format);
        $pattern = self::CODE_BLOCK_PATTERN;

        if (!preg_match_all($pattern, $html, $matches, PREG_OFFSET_CAPTURE)) {
            return $html;
        }

        $sources = [];
        foreach ($matches[1] as $match) {
            $sources[] = html_entity_decode($match[0], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }

        $limit = min(count($sources), self::MAX_BLOCKS);
        $rendered = self::resolveSources(array_slice($sources, 0, $limit), $mode);

        $index = -1;
        $result = preg_replace_callback($pattern, function (array $match) use (&$index, $limit, $rendered, $mode) {
            $index++;
            if ($index >= $limit) {
                return $match[0];
            }

            $source = html_entity_decode($match[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
            $render = $rendered[$source] ?? null;

            if (!is_array($render) || !($render['ok'] ?? false)) {
                return $match[0];
            }

            return self::buildReplacement($render, $mode);
        }, $html);

        return $result ?? $html;
    }

    /**
     * Resolve rendered output for each unique source, using the cache where
     * possible and a single batched sidecar request for any misses.
     *
     * @param string[] $sources
     * @return array<string, array>
     */
    protected static function resolveSources(array $sources, string $mode): array
    {
        $rendered = [];
        $missing = [];

        foreach (array_values(array_unique($sources)) as $source) {
            $cached = Cache::get(self::cacheKey($source, $mode));
            if (is_array($cached)) {
                $rendered[$source] = $cached;
            } else {
                $missing[] = $source;
            }
        }

        if (empty($missing)) {
            return $rendered;
        }

        $results = self::requestRenders($missing, $mode);

        foreach ($missing as $index => $source) {
            $result = $results[$index] ?? ['ok' => false];
            $rendered[$source] = $result;

            // Only cache successes so transient sidecar outages (and fixed
            // syntax errors) recover naturally on the next page view.
            $success = is_array($result) && ($result['ok'] ?? false);
            if ($success) {
                Cache::put(self::cacheKey($source, $mode), $result, now()->addDays(self::CACHE_DAYS));
            }
        }

        return $rendered;
    }

    /**
     * Request renders for the given sources from the sidecar service.
     *
     * @param string[] $sources
     * @return array<int, array>
     */
    protected static function requestRenders(array $sources, string $mode): array
    {
        $baseUrl = rtrim((string) env('PELE_RENDER_URL', 'http://pele-render:3000'), '/');
        $token = (string) env('PELE_RENDER_TOKEN', '');
        $maxWidth = (int) env('PELE_MAX_WIDTH', 900);

        try {
            $response = Http::timeout(15)
                ->withHeaders(['x-pele-token' => $token])
                ->acceptJson()
                ->post($baseUrl . '/render', [
                    'mode' => $mode,
                    'maxWidth' => $maxWidth,
                    'sources' => array_values($sources),
                ]);
        } catch (\Throwable $exception) {
            Log::warning('Pele render service unreachable: ' . $exception->getMessage());
            return [];
        }

        if (!$response->successful()) {
            Log::warning('Pele render service returned HTTP ' . $response->status());
            return [];
        }

        $results = $response->json('results');

        if (!is_array($results)) {
            Log::warning('Pele render service returned an unexpected payload');
            return [];
        }

        return $results;
    }

    /**
     * Build the HTML used to replace an original code block.
     */
    protected static function buildReplacement(array $render, string $mode): string
    {
        $type = htmlspecialchars((string) ($render['type'] ?? 'diagram'), ENT_QUOTES, 'UTF-8');

        if ($mode === 'pdf' && !empty($render['pngDataUri'])) {
            $width = (int) ($render['width'] ?? 0);
            $height = (int) ($render['height'] ?? 0);
            $src = htmlspecialchars((string) $render['pngDataUri'], ENT_QUOTES, 'UTF-8');

            return sprintf(
                '<div class="pele-diagram pele-diagram--image"><img src="%s" alt="Pele %s diagram"%s%s class="pele-diagram-image"></div>',
                $src,
                $type,
                $width > 0 ? ' width="' . $width . '"' : '',
                $height > 0 ? ' height="' . $height . '"' : '',
            );
        }

        $svg = (string) ($render['svg'] ?? '');
        if ($svg === '') {
            return '<div class="pele-diagram pele-diagram--error">Unable to render diagram</div>';
        }

        return '<div class="pele-diagram" data-pele-type="' . $type . '">' . $svg . '</div>';
    }

    /**
     * Map a BookStack render format to a Pele render mode.
     */
    protected static function modeFromFormat(string $format): string
    {
        return match (strtolower($format)) {
            'pdf' => 'pdf',
            'html' => 'export',
            default => 'web',
        };
    }

    protected static function cacheKey(string $source, string $mode): string
    {
        return self::CACHE_PREFIX . $mode . ':' . self::VERSION . ':' . hash('sha256', $source);
    }
}
