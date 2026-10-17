<?php

/**
 * Pele Diagrams module for BookStack.
 *
 * Renders ```mermaid code blocks (Markdown fences) and code blocks with the
 * "mermaid" language (WYSIWYG) as Pele diagrams, server-side.
 *
 * Transformation is applied via view overrides of the page display partials
 * (see views/), which run after BookStack's content filtering.
 * Web views receive var-driven SVG (themed by the BookStack stylesheet),
 * while exports receive flattened SVG (HTML/ZIP) or high-DPI PNG (PDF).
 */

use BookStack\Facades\Theme;
use BookStack\Theming\ThemeEvents;
use BookStack\Theming\ThemeViews;

require_once __DIR__ . '/PeleTheme.php';

Theme::listen(ThemeEvents::THEME_REGISTER_VIEWS, function (ThemeViews $themeViews) {
    $themeViews->renderBefore('layouts.parts.base-body-start', 'pele-assets', 40);
});
