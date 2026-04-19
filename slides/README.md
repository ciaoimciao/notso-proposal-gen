# HTML Slide Generation System

This directory contains the HTML-based slide generation system that replaces the python-pptx backend.

## Files

- **base.css** - Base stylesheet for all slides with CSS custom properties for brand colors, typography, spacing, and component styles
- **../generate_html.js** - Node.js script that reads proposal JSON from stdin and generates PDF via Puppeteer

## Architecture

The system uses:
1. **HTML Templates** - 18 slide templates (s1-s18) defined as JavaScript functions in generate_html.js
2. **CSS Styling** - Comprehensive base.css with CSS variables for theme customization
3. **Puppeteer** - Headless browser rendering to PDF (16:9 landscape)
4. **Data-driven** - Reads the same JSON proposal format as the Python generator

## Usage

```bash
echo '{"format":"pdf","proposal":{...},"client":{...},"selected_slides":["s1","s2",...]}' | node generate_html.js
```

### Input JSON Format

```json
{
  "format": "pdf",
  "output_path": "/path/to/output.pdf",
  "client": {
    "name": "Client Name",
    "color1": "#0b3c8c",
    "color2": "#e63946",
    "color3": "#f5a623",
    "color4": "#e74c3c"
  },
  "proposal": {
    "mascot_name": "Friendly AI",
    "_mascot_images": {
      "cover": "/path/to/mascot.png",
      "option_a": "/path/to/option_a.png",
      "option_b": "/path/to/option_b.png",
      "expression_0": "/path/to/expression_0.png"
    },
    "s1": { "headline": "...", "lead": "..." },
    "s3": { "headline": "Pain Points", "points": [...] },
    ...
  },
  "selected_slides": ["s1", "s2", "s3", ...]
}
```

## 18 Slides

| Slide | Template | Purpose |
|-------|----------|---------|
| s1 | Cover | Title, tagline, mascot image |
| s2 | Table of Contents | Auto-generated from selected slides |
| s3 | Pain Points | Hero band with 3 numbered cards |
| s4 | Market Opportunity | Stats cards with competitive gaps |
| s5 | Core Features | 2x2 grid of feature cards with accent bars |
| s6 | Mascot Selection | 2-3 option cards with image slots |
| s7 | Mascot Design | Large title, personality, traits, description |
| s8 | Personality & Empathy | 3x3 expression grid with images |
| s9 | Chat Demo | Mascot image + chat window mockup |
| s10 | Chatflow Design | Dark theme, 5-stage timeline |
| s11 | Knowledge Base | Input → Mascot → Output process rows |
| s12 | Data & Insights | Dashboard placeholder + metrics grid |
| s13 | ROI Evidence | 4 stat cards + before/after comparison |
| s14 | Roadmap | 5-phase timeline with items |
| s15 | Pricing | Dark theme, 3 tier cards + 4 addon cards (FIXED pricing) |
| s16 | Promo Materials | 3 material cards with asset slots |
| s17 | Licensing | 2x2 grid of license cards with optional note |
| s18 | Thank You | Dark bg, contact card, mascot image |

## CSS Variables

All brand colors and spacing are defined as CSS custom properties in `base.css` and overridden per client:

```css
:root {
  --brand-c1: #0b3c8c;              /* Primary */
  --brand-c2: #e63946;              /* Accent 1 */
  --brand-c3: #f5a623;              /* Accent 2 */
  --brand-c4: #e74c3c;              /* Accent 3 */
  --text-primary: #1a1a1a;
  --bg-light: #f4f4f3;
  /* ... and more */
}
```

## Component Classes

Common CSS classes for building slides:

- `.slide` - Slide container (1440x810px)
- `.slide-header` - Title section with accent line
- `.slide-content` - Main content area
- `.card` - Card component
- `.card-accent-left` / `.card-accent-top` - Cards with colored bars
- `.hero-band` - Large title section with accent line
- `.pill` - Rounded badge
- `.mascot-slot` - Image placeholder with dashed border
- `.grid-2` / `.grid-3` / `.grid-4` / `.grid-2x2` - Grid layouts
- `.stat-card` - For metrics and stats
- `.timeline` / `.timeline-node` - For roadmap/phases
- `.chat-window` / `.chat-message` / `.chat-bubble` - Chat mockup
- Dark theme: `.dark-bg` and `.slide.dark-bg` classes

## Mascot Images

Images are passed as file paths in `_mascot_images` dict. The script:
1. Tries to load the file as a data URI
2. Falls back to placeholder if file not found
3. Supports PNG, JPG, GIF, WebP

Keys used: `cover`, `option_a`, `option_b`, `option_c`, `expression_0` through `expression_8`, `material_0` through `material_2`

## Pricing (s15)

Pricing is **FIXED** and hardcoded in the script:
- 3 tiers: Starter (€399), Premium (€699), Enterprise (Custom)
- 4 add-ons: Extra Character Design, Extra Journey Slot, Partner License, Whitelabel License
- Only headline and lead text are customizable

## Design Principles

- **Clean typography**: Poppins font throughout, hierarchy from 14px body to 72px headings
- **Whitespace**: Generous padding and margins for breathing room
- **Brand colors**: Client colors cycle through components for visual variety
- **Light vs Dark**: Most slides use light (#F4F4F3), Chatflow (s10) and Pricing (s15) use dark
- **Consistency**: Slide header with brand-colored underline appears on every content slide
- **Footer**: "Prepared for {client} · by notso.ai" on all slides except Cover and Thank You

## Dependencies

- **puppeteer** - For headless rendering and PDF generation
- **Node.js** - v18+

Install puppeteer if not already installed:
```bash
npm install puppeteer
```

## Development Notes

- All slide templates are synchronous functions returning HTML strings
- The master `renderSlide()` function dispatches to the appropriate template
- CSS is inlined in the generated HTML for reliability
- Print stylesheets ensure exact PDF rendering without margins
- Emoji stripping is automatic via `stripEmoji()` utility
- Image paths are converted to data URIs for self-contained PDFs
