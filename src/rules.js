// Slop Teller rules. This is the file to edit when the tells change.
//
// copy rules      - regex over the page's visible text, grouped per block.
//                   scope: "any" (default) | "heading" (h1-h3 only) | "body" (not headings) | "whole" (entire block text must match)
//                   weight = points per occurrence, cap = max points for the rule.
// fingerprints    - traces left by AI site builders and untouched starters.
// design rules    - metadata only; the detectors live in scanner.js under the same id.
//
// Write "why" and "fix" in plain words: they go straight into the exported Markdown.
globalThis.SlopRules = globalThis.SlopRules || {
  version: 1,

  copy: [
    {
      id: 'em-dash',
      label: 'Em dashes',
      short: 'em dash',
      pattern: '\u2014',
      weight: 1,
      cap: 15,
      why: 'Em dashes are the most-cited sign of AI-written copy, especially several per paragraph.',
      fix: 'Rewrite each one by context: a comma for an aside, a colon before a list or explanation, a full stop for a new clause, parentheses for an interruption. Do not replace them all with commas.',
    },
    {
      id: 'spaced-en-dash',
      label: 'Spaced en dashes used as em dashes',
      short: 'en dash',
      pattern: ' \u2013 ',
      weight: 1,
      cap: 6,
      why: 'A spaced en dash in prose is usually an em dash in disguise.',
      fix: 'Rewrite the sentence the same way as an em dash. Keep en dashes only in number ranges (2020-2024).',
    },
    {
      id: 'stock-phrases',
      label: 'Stock AI phrases',
      short: 'stock phrase',
      pattern:
        "\\b(?:seamless(?:ly)?|leverag(?:e|es|ed|ing)|delv(?:e|es|ing)|a testament to|elevat(?:e|es|ed|ing)|robust|cutting[- ]edge|unlock(?:s|ing)?|empower(?:s|ing|ed)?|ever[- ](?:evolving|changing) landscape|meticulous(?:ly)?|game[- ]chang(?:er|ing)|revolutioni[sz](?:e|es|ed|ing)|harness(?:es|ing)? the power|supercharg(?:e|es|ed|ing)|effortless(?:ly)?|streamlin(?:e|es|ed|ing)|unparalleled|tapestry|in the realm of|embark(?:s|ing)? on|navigat(?:e|ing) the complexities|in today['\u2019]s (?:fast[- ]paced|digital|ever[- ]changing) world|world[- ]class|next[- ]level|to the next level|look no further|dive (?:deep )?into|at the forefront|crafted with (?:care|love|precision)|it['\u2019]s (?:important|worth) (?:to note|noting)|plays? a (?:crucial|pivotal|vital) role|pivotal|transformative|holistic|synerg(?:y|ies)|unleash(?:es|ing)?|reimagin(?:e|ed|ing)|boost your|all-in-one)\\b",
      weight: 2,
      cap: 24,
      why: 'These words and phrases show up far more often in AI-generated copy than in copy people write.',
      fix: 'Replace each with a plain, specific statement of what the product does or what the reader gets. Name the concrete thing instead of the abstraction ("cuts invoicing to five minutes", not "streamlines your workflow").',
    },
    {
      id: 'not-just',
      label: '"Not just X, it\'s Y" constructions',
      short: 'not just X',
      pattern:
        "\\bnot (?:just|only|merely) [^.!?\\n]{1,60}?[,;:\u2014\u2013-]\\s*(?:it['\u2019]s|it is|but|we['\u2019]re|they['\u2019]re|this is|it['\u2019]s about)\\b",
      weight: 3,
      cap: 9,
      why: 'The "It\'s not just X, it\'s Y" contrast is a signature AI sentence shape.',
      fix: 'State the actual claim directly in one sentence. Drop the contrast unless there is a real comparison to make.',
    },
    {
      id: 'punchy-fragments',
      label: 'Three-word fragment lists',
      short: 'fragments',
      scope: 'whole',
      pattern: '^(?:[\\p{L}-]+[.!]\\s+){2,3}[\\p{L}-]+[.!]$|^No [^.]{1,25}\\. No [^.]{1,25}\\. (?:Just|Only) [^.]{1,30}\\.$',
      flags: 'u',
      weight: 3,
      cap: 6,
      why: 'Lines like "Fast. Secure. Reliable." or "No X. No Y. Just Z." are a stock AI rhythm.',
      fix: 'Turn the fragments into one sentence that says something specific, or cut them.',
    },
    {
      id: 'emoji-led',
      label: 'Emoji used as bullets or icons',
      short: 'emoji bullet',
      scope: 'body',
      // An emoji followed by text, like a bullet. Arrows used as link icons don't count.
      pattern: '^\\s*(?![\\u2190-\\u21FF\\u27A1\\u2B05-\\u2B07])[\\p{Extended_Pictographic}\\u2705\\u2728]\\uFE0F?\\s+\\S',
      flags: 'u',
      weight: 2,
      cap: 10,
      why: 'Lines that start with an emoji (rockets, sparkles, check marks) are a common AI formatting habit.',
      fix: 'Remove the emoji, or replace them with the site\'s own icons or plain list bullets.',
    },
    {
      id: 'emoji-heading',
      label: 'Emoji in headings',
      short: 'emoji heading',
      scope: 'heading',
      pattern: '[\\p{Extended_Pictographic}\\u2728]',
      flags: 'u',
      weight: 2,
      cap: 6,
      why: 'Decorative emoji in headings are a common AI formatting habit.',
      fix: 'Remove the emoji from the heading.',
    },
    {
      id: 'generic-headings',
      label: 'Generic section headings',
      short: 'generic heading',
      scope: 'heading',
      pattern:
        "^\\s*(?:why choose us|why choose|ready to (?:get started|transform|take|elevate|supercharge)|what our (?:customers|clients|users) (?:are )?say|trusted by|loved by|get started today|everything you need|join thousands|say goodbye to|built for (?:the )?(?:modern|teams|everyone)|how it works)",
      weight: 1,
      cap: 5,
      why: 'Template section titles like "Why choose us?" make a page read as generated.',
      fix: 'Rename each section with something specific to this business: what is actually in the section.',
    },
    {
      id: 'placeholder-content',
      label: 'Placeholder content left in',
      short: 'placeholder',
      pattern: '\\b(?:lorem ipsum|john doe|jane doe|acme (?:inc|corp|co)|your company name)\\b|\\(555\\) ?\\d{3}|\\b555-\\d{4}\\b|\\b(?:example|you|hello)@example\\.com\\b',
      weight: 3,
      cap: 9,
      why: 'Placeholder names, numbers and filler text suggest the page was generated and never finished.',
      fix: 'Replace with real content, or remove the section until it exists.',
    },
  ],

  fingerprints: {
    // Matched against script/link/iframe/img URLs, meta tags, and id/class names.
    // These are from public builder output; verify against real sites when updating.
    builderPattern:
      'lovable|gpteng|gptengineer|\\bv0\\.(?:dev|app)\\b|bolt\\.new|\\bstackblitz\\b|tempolabs|tempo-devtools|same\\.new|create\\.xyz|\\bdurable\\.co\\b|10web',
    // Default hosting domains of AI builders (the page's own hostname).
    builderHosts: '(?:^|\\.)(?:lovable\\.app|lovableproject\\.com|bolt\\.host|same\\.dev)$',
    badgeText: '(?:edit|made|built|created|powered) (?:with|by|in) (?:lovable|v0|bolt|tempo|same|create)',
    builderAttrs: ['data-lov-id', 'data-lov-name', 'data-component-path', 'data-tempo-id'],
    starterTitles: ['vite + react + ts', 'vite + react', 'vite app', 'react app', 'create next app', 'next.js app'],
    // Builder-specific descriptions ("Lovable Generated Project") are caught by builderPattern instead.
    starterDescriptions: ['generated by create next app', 'web site created using create-react-app'],
    starterFiles: ['/vite.svg', '/placeholder.svg', 'next.svg', 'vercel.svg', '/file.svg', '/globe.svg', '/window.svg'],
    rules: {
      'builder-trace': {
        label: 'AI site builder traces',
        short: 'builder trace',
        weight: 15,
        cap: 30,
        why: 'The page loads scripts, tags or badges from an AI site builder. This is direct evidence, not a style judgement.',
        fix: 'Remove builder scripts, badges, meta tags and preview images from the production build (for example the "Edit with" badge and the builder\'s Open Graph image). Replace the builder\'s preview image with one of the site\'s own.',
      },
      'builder-attrs': {
        label: 'Builder editing attributes in the HTML',
        short: 'builder attrs',
        weight: 15,
        cap: 15,
        why: 'Elements carry attributes that AI builders add to map the page back to their editor.',
        fix: 'Disable the builder\'s component tagger plugin for production builds so these attributes are not shipped.',
      },
      'starter-leftovers': {
        label: 'Untouched starter-template leftovers',
        short: 'starter leftover',
        weight: 8,
        cap: 16,
        why: 'The default title, description, favicon or placeholder images from a starter template are still in place.',
        fix: 'Set a real page title and meta description, replace the default favicon, and swap placeholder images for real ones.',
      },
    },
  },

  design: {
    'gradient-text': {
      label: 'Gradient-filled text',
      short: 'gradient text',
      weight: 4,
      cap: 8,
      why: 'Headline words filled with a colour gradient are one of the most recognisable AI landing-page looks.',
      fix: 'Consider a solid brand colour for the text. Keep it if the gradient is a deliberate part of the brand.',
    },
    'purple-gradient': {
      label: 'Purple and blue gradient backgrounds',
      short: 'purple gradient',
      weight: 3,
      cap: 6,
      why: 'Violet, indigo and purple-to-blue gradients are the default palette of many AI generators.',
      fix: 'Consider the site\'s own brand colours or a flat background. Keep it if the client chose it.',
    },
    'hero-badge': {
      label: 'Pill badge above the headline',
      short: 'hero badge',
      weight: 4,
      cap: 4,
      why: 'A small rounded "New" or "Introducing" pill above a centred headline is a stock AI hero layout.',
      fix: 'Remove the pill or work its message into the copy. If it announces something real, give it a design specific to this brand.',
    },
    'centered-hero': {
      label: 'Centred hero with two buttons',
      short: 'stock hero',
      weight: 2,
      cap: 2,
      why: 'A centred headline, one line of subtext and a primary plus secondary button is the default AI hero.',
      fix: 'Consider a layout that shows the product or the work first. This is a suggestion; many human sites use this layout too.',
    },
    'icon-card-grid': {
      label: 'Identical icon feature cards',
      short: 'icon cards',
      weight: 3,
      cap: 6,
      why: 'A row of identical cards, each with an icon, a short title and one sentence, is the stock AI features section.',
      fix: 'Vary the section: show real screenshots, numbers or examples, or give the most important feature more room than the rest.',
    },
    'glass-cards': {
      label: 'Frosted-glass cards',
      short: 'glass card',
      weight: 2,
      cap: 4,
      why: 'Blurred, translucent cards used for content blocks are a common generated-design habit.',
      fix: 'Consider solid surfaces for content cards. Blur on a sticky navigation bar is normal and is not flagged.',
    },
    'default-font': {
      label: 'Framework default font',
      short: 'default font',
      weight: 1,
      cap: 1,
      why: 'Inter or Geist on everything is the default in most AI builders and starter kits. It is a weak signal on its own.',
      fix: 'Consider a typeface chosen for the brand, at least for headings.',
    },
  },
};
