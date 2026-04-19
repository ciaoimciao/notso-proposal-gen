/**
 * Notso.ai mascot style lock for image generation pipeline (JavaScript port).
 *
 * Mirrors notso_style_prompt.py 1:1. The Python module is the spec; this JS
 * module exists so that server.js can call build_style_prompt() without a
 * Python subprocess hop. Any change to the Python module MUST be mirrored
 * here in the same commit.
 *
 * Every image generation call in server.js /api/mascot/generate MUST go
 * through buildStylePrompt() so the rules documented in notso_style_lock.md
 * are enforced at the prompt layer.
 *
 * Locked: 2026-04-12  (v1.0)
 */

const STYLE_VERSION = '1.0';

// ─────────────────────────────────────────────────────────────────────────────
// Core style prefix. Prepended to every positive prompt.
// ─────────────────────────────────────────────────────────────────────────────
const STYLE_PREFIX =
  'A 3D-rendered character in the distinctive Notso AI signature style. ' +
  'Matte clay and vinyl designer-toy finish, smooth even surface, no gloss, ' +
  'no plastic shine, no metallic reflection. ' +
  'Soft three-point studio lighting with a warm key light from upper ' +
  'camera-left, a low-intensity fill from the right, and a single thin rim ' +
  'light on the silhouette. ' +
  'Large round eyes with a solid black pupil and one small white highlight ' +
  'point — no iris detail, no eyelashes, no catchlight shapes. ' +
  'Thick, dark, prominent eyebrows that carry the emotion. ' +
  'No hard black outlines; silhouette is defined by form and rim light. ' +
  'Fully transparent background (PNG with alpha channel, no baked backdrop). ' +
  'Character is centered, full body visible, slight low-angle hero framing. ';

// ─────────────────────────────────────────────────────────────────────────────
// Negative prompt. Appended to every generation call.
// ─────────────────────────────────────────────────────────────────────────────
const NEGATIVE_SUFFIX =
  'blurry, low quality, distorted, extra limbs, extra fingers, malformed ' +
  'hands, hard black outlines, cel shading, anime, manga, comic speed lines, ' +
  'cyberpunk, Y2K, metallic finish, chrome, neon glow, holographic, ' +
  'plastic shine, glossy surface, glass refraction, ' +
  'realistic skin pores, realistic hair strands, photorealistic human, ' +
  'stop-motion texture, clay thumbprints, visible sculpting marks, ' +
  'fur strand simulation, hard cast shadows, dramatic contrast, ' +
  'firearms, guns, weapons, knives, ' +
  'religious symbols, crosses, crescents, stars of david, halos, ' +
  'nudity, revealing clothing, underwear, ' +
  'political symbols, political flags, ' +
  'cigarettes, smoking, alcohol, beer, wine, ' +
  'brand logo on skin, text on face, tattoos on face, ' +
  'baked background, cream grid, pastel card, studio backdrop, ' +
  'colored backdrop, vignette, drop shadow baked in, ground shadow, ' +
  'multiple characters unless requested, watermark, signature, frame, border';

// ─────────────────────────────────────────────────────────────────────────────
// Proportion tier modifiers.
// ─────────────────────────────────────────────────────────────────────────────
const HERO_TIER_MODIFIER =
  'Adult stylized proportions, head-to-body ratio approximately 1 to 2, ' +
  'defined shoulders and posture, hands capable of holding objects and ' +
  'performing precise gestures. ';

const CHIBI_TIER_MODIFIER =
  'Chibi toy proportions, head-to-body ratio approximately 1 to 1.4, ' +
  'oversized head, short stubby limbs, designer vinyl collectible ' +
  'silhouette reminiscent of blind-box figures but with a distinctive ' +
  'Notso AI face. ';

// ─────────────────────────────────────────────────────────────────────────────
// Mood modifiers.
// ─────────────────────────────────────────────────────────────────────────────
const MOOD_FRIENDLY =
  'Friendly welcoming pose, subtle smile, eye contact with camera, ' +
  'relaxed shoulders. ';

const MOOD_MOODY =
  'Moody variant: single low-angle warm key light, contemplative posture, ' +
  'subtle desaturation on wardrobe, eyebrows angled for worry or focus. ' +
  'Transparent background still — do not bake a dark backdrop. ';

const MOOD_CELEBRATE =
  'Celebratory pose, arms raised or one fist up, bright wide smile, ' +
  'eyebrows raised, energetic stance. ';

const MOOD_THINKING =
  'Thinking pose, one hand near chin or temple, eyes slightly up, ' +
  'eyebrows gently furrowed, mouth in a small neutral line. ';

const MOOD_MAP = {
  friendly: MOOD_FRIENDLY,
  moody: MOOD_MOODY,
  celebrate: MOOD_CELEBRATE,
  thinking: MOOD_THINKING,
};

// ─────────────────────────────────────────────────────────────────────────────
// Species modifiers.
// ─────────────────────────────────────────────────────────────────────────────
function speciesLine(species) {
  const s = String(species || '').toLowerCase().trim();
  if (['human', 'humanoid', 'person', 'level1', '1'].includes(s)) {
    return (
      'Humanoid character, stylized person, neutral warm skin tone ' +
      '(beige / peach / light brown / tan). '
    );
  }
  if (['animal', 'personified animal', 'level2', '2'].includes(s)) {
    return (
      'Personified animal character with humanlike posture and clothing. ' +
      'Natural neutral fur or hide colour (white, grey, brown, tan, ' +
      'cream) — brand colour lives on clothing only, never on fur. '
    );
  }
  if (['object', 'personified object', 'level3', '3'].includes(s)) {
    return (
      'Personified object character — an everyday object brought to ' +
      'life with a simple face, small hands, and small feet, while ' +
      'keeping its original shape and base colour. '
    );
  }
  if (['abstract', 'pure abstract', 'level4', '4'].includes(s)) {
    throw new Error(
      "Level 4 (pure abstract form) is disallowed by the Notso AI " +
      "style lock v1.0. Use Level 3 (personified object) instead — " +
      "e.g. 'a lightbulb with a face, arms, and legs' rather than " +
      "'a bolt of light'."
    );
  }
  // default fallback = humanoid
  return 'Humanoid character, stylized person, neutral warm skin tone. ';
}

// ─────────────────────────────────────────────────────────────────────────────
// Global negatives that cannot be overridden by callers.
// ─────────────────────────────────────────────────────────────────────────────
const GLOBAL_FORBIDDEN_IDENTITIES =
  'Never depict the character as a robot, cyborg, or artificial intelligence. ' +
  'The character is a digital colleague, not a machine. ';

// ─────────────────────────────────────────────────────────────────────────────
// Style transfer modifier — used when client has an existing mascot and wants
// it re-rendered in Notso style. Turns the pipeline from "create a fresh
// character" into "translate this character into Notso style while preserving
// identity". Paired with a reference image in the Gemini call.
// ─────────────────────────────────────────────────────────────────────────────
// Standard style-transfer: re-render in Notso style but allow some Notso
// traits (eyes, eyebrows) to blend with the client's design.
const STYLE_TRANSFER_MODIFIER =
  'STYLE TRANSFER MODE: The attached reference image is the client\'s ' +
  'existing mascot. Re-render this exact character in the Notso AI ' +
  'signature style described above. PRESERVE CHARACTER IDENTITY ' +
  '(silhouette, body shape, species, facial structure, head accessories, ' +
  'colour identity) — the output must be immediately recognisable as the ' +
  'same character. Only change the rendering: apply Notso matte clay / ' +
  'vinyl finish, Notso three-point lighting, transparent PNG background. ' +
  'Keep the character\'s original eye style and eyebrow style unless they ' +
  'conflict with the 3D clay aesthetic. ' +
  'Do NOT generate a new unrelated character. Do NOT copy the reference ' +
  'background. Do NOT add extra characters. ';

// Strict faithful reproduction: 100% follow the client's mascot design.
// Only swap material to 3D clay + transparent BG. Everything else untouched.
const FAITHFUL_TRANSFER_MODIFIER =
  'FAITHFUL REPRODUCTION MODE: The attached reference image is the client\'s ' +
  'existing mascot. Reproduce this character with 100% fidelity — same ' +
  'silhouette, same species, same facial features, same eyes, same eyebrows, ' +
  'same head accessories, same colour palette, same pose if possible. ' +
  'The ONLY change allowed is the rendering technique: convert to Notso ' +
  'matte clay / vinyl 3D finish with three-point lighting and transparent ' +
  'PNG background. Do NOT alter facial features. Do NOT add Notso-specific ' +
  'eye formula or eyebrows. Do NOT change the character\'s proportions. ' +
  'Do NOT generate a new unrelated character. Do NOT copy the reference ' +
  'background. Do NOT add extra characters. ';

// ─────────────────────────────────────────────────────────────────────────────
// Main builder — every generation call goes through this.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Build the final {positive, negative} prompt pair for one image.
 *
 * @param {Object} opts
 * @param {string} opts.characterDescription - Free-text description of the character.
 * @param {string} opts.brandColorName - Human-readable colour name (e.g. "vivid red").
 * @param {string} [opts.tier="hero"] - "hero" or "chibi".
 * @param {string} [opts.species="human"] - "human" | "animal" | "object".
 *                                           "abstract" / "level4" throws.
 * @param {string} [opts.mood="friendly"] - "friendly" | "moody" | "celebrate" | "thinking".
 * @param {string|null} [opts.accentColorName=null] - Optional second brand colour.
 * @param {boolean} [opts.styleTransfer=false] - If true, adds STYLE_TRANSFER_MODIFIER
 *                                                for image-to-image preservation of
 *                                                a client's existing mascot.
 * @param {boolean} [opts.faithfulTransfer=false] - If true, uses FAITHFUL_TRANSFER_MODIFIER
 *                                                   (100% reproduce client mascot, no Notso eyes/brows).
 * @returns {{ positive: string, negative: string, version: string }}
 */
function buildStylePrompt({
  characterDescription,
  brandColorName,
  tier = 'hero',
  species = 'human',
  mood = 'friendly',
  accentColorName = null,
  styleTransfer = false,
  faithfulTransfer = false,
}) {
  // ── FAITHFUL TRANSFER: skip ALL Notso style directives ──────────────
  // When faithfulMode is on, we must NOT inject Notso-specific features
  // (eye formula, eyebrows, STYLE_PREFIX, tier/species/mood modifiers)
  // because they conflict with "reproduce with 100% fidelity".
  // We only keep: faithful instruction + 3D render technique + brand color + character description.
  if (faithfulTransfer) {
    const faithfulPositive =
      FAITHFUL_TRANSFER_MODIFIER +
      'Render with a high-quality 3D matte clay / vinyl designer-toy finish. ' +
      'Soft three-point studio lighting with a warm key light from upper ' +
      'camera-left, a low-intensity fill from the right, and a single thin rim ' +
      'light on the silhouette. ' +
      'Fully transparent background (PNG with alpha channel, no baked backdrop). ' +
      'Character is centered, full body visible, slight low-angle hero framing. ' +
      `Brand colour for wardrobe/accessories: ${brandColorName}. ` +
      'Character: ' +
      String(characterDescription || '').trim();

    return {
      positive: faithfulPositive,
      negative: NEGATIVE_SUFFIX,
      version: STYLE_VERSION,
    };
  }

  // ── Normal / Style-Transfer mode ────────────────────────────────────
  const tierMod =
    String(tier).toLowerCase() === 'hero'
      ? HERO_TIER_MODIFIER
      : CHIBI_TIER_MODIFIER;
  const speciesMod = speciesLine(species);
  const moodMod = MOOD_MAP[String(mood).toLowerCase()] || MOOD_FRIENDLY;

  let colorLine;
  if (accentColorName) {
    colorLine =
      `Wardrobe and accessories use a single ${brandColorName} ` +
      `signature colour with a ${accentColorName} accent. ` +
      'Skin, fur, and hair stay neutral — brand colour does NOT ' +
      'appear on the body itself. ';
  } else {
    colorLine =
      `Wardrobe and accessories use a single ${brandColorName} ` +
      'signature colour. Skin, fur, and hair stay neutral — brand ' +
      'colour does NOT appear on the body itself. ';
  }

  const transferLine = styleTransfer ? STYLE_TRANSFER_MODIFIER : '';

  const positive =
    STYLE_PREFIX +
    tierMod +
    speciesMod +
    colorLine +
    moodMod +
    GLOBAL_FORBIDDEN_IDENTITIES +
    transferLine +
    'Character: ' +
    String(characterDescription || '').trim();

  return {
    positive,
    negative: NEGATIVE_SUFFIX,
    version: STYLE_VERSION,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: pre-baked prompts for the existing reference cast.
// Used for regression testing the style lock against known-good outputs.
// Mirrors REFERENCE_CAST in notso_style_prompt.py.
// ─────────────────────────────────────────────────────────────────────────────
const REFERENCE_CAST = {
  fin: {
    characterDescription:
      'Fin, a financial expert for a sports club. Brown swept-back hair, ' +
      'near-black thick eyebrows, dark eyes, warm friendly smile. ' +
      "Wears a red vest with a small white 'Fin' name tag over a white " +
      'long-sleeve shirt and dark trousers. ',
    brandColorName: 'vivid red',
    tier: 'hero',
    species: 'human',
    mood: 'friendly',
  },
  willy: {
    characterDescription:
      'Willy, an ergonomic-chair sales assistant. Curly light-brown ' +
      "hair under a green bucket hat with a white '7' on it. Green " +
      'cardigan over a light scarf, cream trousers, white sneakers. ',
    brandColorName: 'forest green',
    accentColorName: 'cream',
    tier: 'hero',
    species: 'human',
    mood: 'friendly',
  },
  woof: {
    characterDescription:
      'Woof, a university student buddy. A friendly husky with grey ' +
      'and white fur, large black eyes, tiny yellow cheek blush dots, ' +
      "wearing a royal-blue hoodie with a 'Sarajevo University' logo " +
      'across the chest and a small backpack strap visible. ',
    brandColorName: 'royal blue',
    accentColorName: 'bright yellow',
    tier: 'chibi',
    species: 'animal',
    mood: 'friendly',
  },
};

function referencePrompt(name) {
  const spec = REFERENCE_CAST[String(name).toLowerCase()];
  if (!spec) throw new Error(`Unknown reference cast member: ${name}`);
  return buildStylePrompt(spec);
}

module.exports = {
  STYLE_VERSION,
  STYLE_PREFIX,
  NEGATIVE_SUFFIX,
  HERO_TIER_MODIFIER,
  CHIBI_TIER_MODIFIER,
  MOOD_FRIENDLY,
  MOOD_MOODY,
  MOOD_CELEBRATE,
  MOOD_THINKING,
  GLOBAL_FORBIDDEN_IDENTITIES,
  STYLE_TRANSFER_MODIFIER,
  FAITHFUL_TRANSFER_MODIFIER,
  buildStylePrompt,
  referencePrompt,
  REFERENCE_CAST,
};

// CLI smoke test: `node notso_style_prompt.js`
if (require.main === module) {
  const fin = referencePrompt('fin');
  console.log('='.repeat(72));
  console.log(`STYLE LOCK v${fin.version} — FIN POSITIVE PROMPT`);
  console.log('='.repeat(72));
  console.log(fin.positive);
  console.log();
  console.log('='.repeat(72));
  console.log('NEGATIVE PROMPT');
  console.log('='.repeat(72));
  console.log(fin.negative);
  console.log();

  // Verify Level 4 still throws
  try {
    buildStylePrompt({
      characterDescription: 'a bolt of light',
      brandColorName: 'gold',
      species: 'level4',
    });
    console.error('ERROR: Level 4 should have thrown!');
    process.exit(1);
  } catch (e) {
    console.log(`✓ Level 4 correctly rejected: ${e.message.slice(0, 80)}...`);
  }

  // Verify style transfer mode adds the modifier
  const transfer = buildStylePrompt({
    characterDescription: 'the attached client mascot',
    brandColorName: 'teal',
    species: 'object',
    tier: 'chibi',
    styleTransfer: true,
  });
  console.log(
    `✓ Style transfer mode: ${
      transfer.positive.includes('STYLE TRANSFER MODE') ? 'active' : 'MISSING'
    }`
  );
}
