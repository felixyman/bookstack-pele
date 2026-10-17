{{-- Pele diagram styles, loaded on page views --}}
@if(request()->fullUrlIs('*/page/*'))
    <link rel="stylesheet" href="{{ url('/theme/' . \BookStack\Facades\Theme::getTheme() . '/pele-bookstack.css') }}?v={{\PeleTheme::VERSION}}">
@endif
