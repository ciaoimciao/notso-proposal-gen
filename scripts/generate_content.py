#!/usr/bin/env python3
"""
Generate a customized proposal (AI-chosen slide list + AI-written content)
by reading the client's free-text description. Uses Claude Opus 4.6.

Two levels of AI agency:
  1) AI READS the client's description and SELECTS which of the 18 available
     slides best fit this particular pitch — based on the client's industry,
     maturity, brand needs, and any brief you provide.
  2) AI WRITES the copy for only those selected slides, tailored to the
     client's specific language, users, and pain.

Usage:
  python3 generate_content.py fixtures/demo/04-yazio.json
  python3 generate_content.py fixtures/demo/04-yazio.json --brief "Returning client, upsell API tier"
  python3 generate_content.py fixtures/demo/04-yazio.json --compare --out compare.html
"""
import json
import os
import sys
import urllib.request
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load_claude_key():
    with open(os.path.join(ROOT, '.secrets.json')) as f:
        return json.load(f)['CLAUDE_API_KEY']


# ─── Style guide & few-shot examples (plug into prompt) ──────────────
STYLE_GUIDE = """\
Writing style — EVERY line must follow these rules:

1. PUNCHY. Short sentences. Verbs first. No corporate fluff.
2. BENEFIT BEFORE FEATURE. Never start with "We offer..." or "Our platform provides...".
   Start with what the customer FEELS or GETS. Features are supporting evidence.
3. CONCRETE. Replace "help you" / "enable you to" with specific verbs: "spot",
   "cut", "unlock", "turn ___ into ___", "stop ___ing", "answer", "catch".
4. NO AI BUZZWORDS unless the client's product is itself AI-first.
   Avoid "leverage", "empower", "seamless", "cutting-edge", "transform your business".
5. HEADLINES ≤ 10 WORDS. Sub-headlines / taglines ≤ 14 words.
   Body copy: 1–2 tight sentences, never a wall.
6. SPECIFIC TO THE CLIENT. Name their industry, their users, their problem
   by name. Generic = dead.
7. COPY SHOULD MAKE A BUSY EXECUTIVE WANT TO READ THE NEXT SLIDE.
   If it wouldn't survive a quick scan, rewrite it."""

FEW_SHOT_EXAMPLES = """\
Examples of GOOD copy (study the voice):

Cover tagline (for a nutrition app mascot):
✓ "Meet the coach your users already trust."
✗ "We provide a comprehensive AI mascot solution for your platform."

Pain points intro (for a bank):
✓ "Your app does the job. It doesn't win hearts."
✗ "Banking customers today demand more engaging digital experiences."

Core features headline:
✓ "What your mascot actually does."
✗ "Core Product Features and Capabilities."

Chat experience line:
✓ "Your users talk. The mascot listens. Everyone wins."
✗ "A sophisticated conversational AI experience for end users."

Thank-you closing:
✓ "Ready to give your brand a face?"
✗ "We look forward to hearing from you and answering any questions."
"""

SLIDE_MENU = """\
AVAILABLE SLIDES — here is the full menu. You will choose a subset that best
serves THIS client's pitch. Read each slide's purpose carefully before picking.

s1  Cover            — First impression with tagline. ALWAYS include.
s2  TableOfContents  — Map of the deck. Include ONLY if final deck has ≥8 slides.
s3  PainPoints       — What hurts the client's users today. Include when there's
                       a clear user-facing pain the mascot solves. Skip if pitch
                       is purely technical/infrastructure.
s4  MarketOpportunity — Industry size + growth rates. Include when the client is
                        early-stage, entering a new segment, or pitching internal
                        stakeholders on "why invest in AI now". SKIP for mature
                        brands (e.g., big nonprofit, household-name consumer).
s5  CoreFeatures     — What the mascot actually DOES. ALWAYS include.
s6  MascotSelection  — 3-option mascot shortlist. Include ONLY when the mascot
                       hasn't been picked yet. SKIP if client has locked on one.
s7  MascotDesign     — Deep-dive on the chosen mascot. Include if S6 is skipped
                       (client has one mascot) or as a follow-up to S6.
s8  PersonalityEmpathy — Mascot expressions & tone library. Include for brand-
                         led pitches (consumer, lifestyle, charity). Skip for
                         pure B2B infrastructure.
s9  ChatDemo         — Sample conversation transcript. Include when the mascot's
                       primary role is chat. Skip for mascot-as-brand-ambassador
                       pitches where chat is secondary.
s10 ChatflowDesign   — Technical architecture diagram (intent → routing → response).
                       Include for enterprise, technical buyers. Skip for
                       marketing/brand buyers.
s11 KnowledgeBase    — Content strategy. Include when client has a large docs
                       surface area (SaaS, nonprofit, banking). Skip for lean
                       startups or consumer apps with minimal content.
s12 DataInsights     — Analytics dashboard mockup. Include when ROI measurement
                       matters. Skip for brand-awareness-only pitches.
s13 ROIEvidence      — Before/after numbers. ALWAYS include for paid pitches.
s14 Roadmap          — Timeline phases. Include for engagements >8 weeks. Skip
                       for short/tactical projects.
s15 Pricing          — ALWAYS include.
s16 PromoMaterials   — Co-marketing assets (social, email templates, print).
                       Include when client cares about amplification / PR.
                       Skip for internal-only tools.
s17 Licensing        — Legal terms, data handling. Include for enterprise,
                       regulated industries (finance, health, gov). Skip for
                       casual SMB.
s18 ThankYou         — CTA + contact. ALWAYS include.

SELECTION RULES:
- Typical deck is 8–14 slides. Be willing to cut slides that don't serve THIS
  pitch — brevity wins. Do NOT include a slide just because "usually we do".
- Order MUST be ascending s1, s2, s3... (don't reorder).
- ALWAYS include: s1, s5, s13, s15, s18.
- If you include s2 (TOC), you must have ≥8 total slides. Otherwise skip s2.
- If you include s7 you usually skip s6, and vice versa (rarely both).
"""

SCHEMA = """\
Output a SINGLE JSON object with EXACTLY these three top-level keys.

{
  "selected_slides": ["s1", "s3", ...],   // ascending slide IDs you chose
  "selection_rationale": "2-4 sentence plain-language explanation of WHY you
                          chose these slides and cut the others. Speak directly
                          about this client's situation.",
  "content": {
    // ONE entry per slide you selected, following the per-slide schemas below.
    // Do NOT include entries for unselected slides.
  }
}

PER-SLIDE CONTENT SCHEMAS — use only the ones you selected:

"s1": {
    "tagline":  "ONE punchy line (≤14 words) that names what the client gets",
    "lead":     "ONE supporting sentence (≤20 words)",
    "greeting": "A 1-line hook said by the mascot (≤12 words, can use 1st person)"
  },
  "s3": {
    "headline": "≤8-word headline framing the client's pain",
    "intro":    "1-line reframe that hits the emotional core (≤18 words)",
    "points":   [
      "First pain point, punchy (≤16 words)",
      "Second pain point (≤16 words)",
      "Third pain point (≤16 words)"
    ]
  },
  "s4": {
    "headline":       "≤8-word headline about the market window",
    "intro":          "1-line why-now (≤18 words)",
    "industry_size":  "Short market-size claim (e.g., '$12B industry, growing fast')",
    "growth_rate":    "Short growth claim (e.g., '18% YoY')",
    "projected_size": "Short projection (e.g., '$27B by 2030')"
  },
  "s5": {
    "headline": "≤8-word headline naming WHAT the mascot DOES",
    "intro":    "1-line promise (≤18 words)",
    "features": [
      {"title": "≤5-word feature", "description": "≤16-word benefit-first description"},
      {"title": "≤5-word feature", "description": "≤16-word benefit-first description"},
      {"title": "≤5-word feature", "description": "≤16-word benefit-first description"}
    ]
  },
  "s6": {
    "headline": "≤8-word headline framing mascot choice as a strategic decision",
    "intro":    "1-line reasoning (≤18 words)"
  },
  "s7": {
    "tone_desc":  "Short tone descriptor (e.g., 'warm, playful, unpretentious')",
    "personality":"1-2 sentence personality summary (≤35 words)",
    "phrases":    ["Catchphrase 1 (≤8 words)", "Catchphrase 2 (≤8 words)", "Catchphrase 3 (≤8 words)"]
  },
  "s8": {
    "headline": "≤8-word headline",
    "intro":    "1-line supporting (≤18 words)"
  },
  "s9": {
    "headline": "≤8-word headline naming the chat moment",
    "intro":    "1-line framing (≤18 words)",
    "messages": [
      {"from": "user",   "text": "Realistic user question (≤14 words)"},
      {"from": "mascot", "text": "Mascot reply in the tone_desc voice (≤20 words)"},
      {"from": "user",   "text": "Natural follow-up (≤14 words)"},
      {"from": "mascot", "text": "Punchy closing reply (≤18 words)"}
    ]
  },
  "s10": {
    "headline": "≤8-word headline",
    "intro":    "1-line (≤18 words)",
    "stages":   ["Stage 1 name (≤4 words)", "Stage 2 name (≤4 words)", "Stage 3 name (≤4 words)", "Stage 4 name (≤4 words)"]
  },
  "s11": {
    "headline":   "≤8-word headline",
    "intro":      "1-line (≤18 words)",
    "categories": [
      {"title": "≤4-word category", "description": "≤14-word description"},
      {"title": "≤4-word category", "description": "≤14-word description"},
      {"title": "≤4-word category", "description": "≤14-word description"}
    ]
  },
  "s12": {
    "headline": "≤8-word headline",
    "intro":    "1-line (≤18 words)",
    "metrics":  [
      {"label": "≤4-word metric name", "value": "realistic sample value"},
      {"label": "≤4-word metric name", "value": "realistic sample value"},
      {"label": "≤4-word metric name", "value": "realistic sample value"},
      {"label": "≤4-word metric name", "value": "realistic sample value"}
    ]
  },
  "s13": {
    "headline": "≤8-word headline",
    "intro":    "1-line (≤18 words)",
    "before":   "Before-state in one line (≤16 words, set the pain)",
    "after":    "After-state in one line (≤16 words, show the relief)"
  },
  "s14": {
    "headline": "≤8-word headline",
    "intro":    "1-line (≤18 words)",
    "phases":   [
      {"title": "≤4-word phase", "description": "≤16-word outcome"},
      {"title": "≤4-word phase", "description": "≤16-word outcome"},
      {"title": "≤4-word phase", "description": "≤16-word outcome"}
    ]
  },
  "s15": {
    "headline":  "≤8-word headline",
    "reasoning": "1-2 sentence pricing rationale (≤40 words)"
  },
  "s16": {
    "headline": "≤8-word headline",
    "intro":    "1-line (≤18 words)"
  },
  "s17": {
    "headline": "≤8-word headline",
    "intro":    "1-line (≤18 words)",
    "note":     "1-line fine-print reassurance (≤18 words)"
  },
  "s18": {
    "closing_title": "≤8-word closing hook that invites action",
    "closing":       "1-2 sentence warm CTA (≤30 words)"
  }

Return ONLY the JSON. No markdown fences. No preamble. No trailing text.
"""


def build_prompt(client, brief=''):
    name        = client.get('clientName', 'the client')
    industry    = client.get('industry', '')
    use_case    = client.get('useCase', '')
    desc        = client.get('clientDesc', '')
    mascot_name = client.get('mascotName', 'Buddy')
    color       = client.get('color1hex', '')
    lang        = client.get('outputLang', 'en')

    lang_instruction = {
        'en':    'Write everything in natural American English.',
        'zh-TW': '用繁體中文寫 (台灣用語), 但保留品牌名稱和專有名詞的原文。語氣親切但專業、punchy。',
        'zh':    '用繁體中文寫 (台灣用語), 但保留品牌名稱和專有名詞的原文。語氣親切但專業、punchy。',
        'ja':    '日本語でパンチの効いたマーケティング調で書いてください。ブランド名は原文のまま。',
    }.get(lang, 'Write in natural American English.')

    brief_block = ''
    if brief and brief.strip():
        brief_block = f"""\

THIS PITCH'S SPECIFIC BRIEF (from the account owner — HIGH PRIORITY, override
defaults as needed):
{brief.strip()}
"""

    user_msg = f"""\
You are the proposal architect AND copywriter for notso.ai — a company that
builds 3D-animated brand mascots that act as interactive chat widgets on the
client's website and app.

Your job has TWO parts:
  1) Read the client's own description below carefully. Then SELECT which of
     the 18 available slides (menu below) will make the strongest pitch to
     THIS specific client. Skip slides that don't earn their place.
  2) WRITE punchy, specific, client-tailored copy for each slide you selected.

CLIENT:
  Name:      {name}
  Industry:  {industry}
  Use case:  {use_case}
  Mascot:    {mascot_name}
  Brand hex: {color}

About the client (verbatim, their own words):
  {desc}
{brief_block}
{lang_instruction}

{STYLE_GUIDE}

{FEW_SHOT_EXAMPLES}

{SLIDE_MENU}

{SCHEMA}
"""
    return user_msg


def call_claude(user_msg, *, model='claude-opus-4-6', max_tokens=6000):
    api_key = load_claude_key()
    payload = {
        'model': model,
        'max_tokens': max_tokens,
        'messages': [{'role': 'user', 'content': user_msg}],
    }
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
        },
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode('utf-8'))
    text = ''.join(c.get('text', '') for c in data.get('content', []))
    # Strip possible code fences
    if text.strip().startswith('```'):
        text = text.strip().strip('`')
        if text.startswith('json\n'):
            text = text[5:]
    return json.loads(text)


# ─── "Before" (current system output) ───────────────────────────────────
DEFAULT_FALLBACKS = {
    's1':  {'tagline': 'The AI coach for {client}', 'lead': '', 'greeting': 'Hi, I\'m {mascot}! How can I help you today?'},
    's3':  {'headline': 'Pain Points', 'intro': '', 'points': []},
    's4':  {'headline': 'Market Opportunity', 'intro': '', 'industry_size': '', 'growth_rate': '', 'projected_size': ''},
    's5':  {'headline': 'Core Features', 'intro': '', 'features': []},
    's6':  {'headline': 'Mascot Selection', 'intro': ''},
    's7':  {'tone_desc': '', 'personality': '', 'phrases': []},
    's8':  {'headline': 'Personality & Expressions', 'intro': ''},
    's9':  {'headline': 'Chat Experience', 'intro': '', 'messages': []},
    's10': {'headline': 'Chatflow Design', 'intro': '', 'stages': []},
    's11': {'headline': 'Knowledge Base', 'intro': '', 'categories': []},
    's12': {'headline': 'Real-Time Dashboard', 'intro': '', 'metrics': []},
    's13': {'headline': 'ROI Evidence', 'intro': '', 'before': '', 'after': ''},
    's14': {'headline': 'Roadmap', 'intro': '', 'phases': []},
    's15': {'headline': 'Pricing', 'reasoning': ''},
    's16': {'headline': 'Promotional Materials', 'intro': ''},
    's17': {'headline': 'Licensing', 'intro': '', 'note': ''},
    's18': {'closing_title': 'Thank You', 'closing': 'We look forward to hearing from you and answering any questions.'},
}


def before_output(client):
    """What the current system would render with no AI (only hardcoded fallbacks)."""
    name   = client.get('clientName', 'the client')
    mascot = client.get('mascotName', 'Buddy')
    out = {}
    for k, v in DEFAULT_FALLBACKS.items():
        out[k] = {}
        for fk, fv in v.items():
            if isinstance(fv, str):
                out[k][fk] = fv.format(client=name, mascot=mascot)
            else:
                out[k][fk] = fv
    return out


# ─── Side-by-side HTML ──────────────────────────────────────────────────
ALL_SLIDE_LABELS = {
    's1':  'Cover', 's2':  'TableOfContents', 's3':  'PainPoints',
    's4':  'MarketOpportunity', 's5':  'CoreFeatures', 's6':  'MascotSelection',
    's7':  'MascotDesign', 's8':  'PersonalityEmpathy', 's9':  'ChatDemo',
    's10': 'ChatflowDesign', 's11': 'KnowledgeBase', 's12': 'DataInsights',
    's13': 'ROIEvidence', 's14': 'Roadmap', 's15': 'Pricing',
    's16': 'PromoMaterials', 's17': 'Licensing', 's18': 'ThankYou',
}


def render_compare_html(client, before, after_full, brief=''):
    """after_full = {selected_slides, selection_rationale, content}"""
    after         = after_full.get('content', {})
    selected      = after_full.get('selected_slides', list(after.keys()))
    rationale     = after_full.get('selection_rationale', '')
    def esc(s):
        if not isinstance(s, str):
            s = json.dumps(s, ensure_ascii=False)
        return (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))

    def field_rows(bobj, aobj):
        keys = sorted(set(list(bobj.keys()) + list(aobj.keys())))
        rows = []
        for k in keys:
            bv = bobj.get(k, '')
            av = aobj.get(k, '')
            if isinstance(bv, (list, dict)):
                bv = json.dumps(bv, ensure_ascii=False, indent=2)
            if isinstance(av, (list, dict)):
                av = json.dumps(av, ensure_ascii=False, indent=2)
            rows.append(
                f'<tr><td class="k">{esc(k)}</td>'
                f'<td class="b">{esc(bv) or "<em>(empty)</em>"}</td>'
                f'<td class="a">{esc(av) or "<em>(empty)</em>"}</td></tr>'
            )
        return '\n'.join(rows)

    # Slide-selection summary at top
    all_ids = [f's{i}' for i in range(1, 19)]
    skipped = [sk for sk in all_ids if sk not in selected]
    selection_rows = []
    for sk in all_ids:
        label = ALL_SLIDE_LABELS.get(sk, sk)
        if sk in selected:
            selection_rows.append(f'<span class="pill pill-in">{sk} · {label}</span>')
        else:
            selection_rows.append(f'<span class="pill pill-out">{sk} · {label}</span>')
    selection_block = f"""
<section class="selection-section">
  <h2>AI-selected slides</h2>
  <p><b>Kept {len(selected)}/18 slides</b>. Gray = AI chose to skip.</p>
  <div class="pills">{''.join(selection_rows)}</div>
  <div class="rationale"><b>Why:</b> {esc(rationale)}</div>
</section>
"""

    sections = [selection_block]
    for sk in all_ids:
        bobj = before.get(sk, {})
        aobj = after.get(sk, {})
        kept = sk in selected
        tag = '<span class="tag tag-in">kept</span>' if kept else '<span class="tag tag-out">skipped by AI</span>'
        # If skipped, show "after" as a single row explaining skip
        if not kept:
            body_rows = f'<tr><td class="k">—</td><td class="b">{esc(json.dumps(bobj, ensure_ascii=False))}</td><td class="a"><em>(AI chose to skip this slide)</em></td></tr>'
        else:
            body_rows = field_rows(bobj, aobj)
        sections.append(f"""
<section>
  <h2>{sk.upper()} · {ALL_SLIDE_LABELS.get(sk, '')} {tag}</h2>
  <table>
    <thead><tr><th>field</th><th class="bh">BEFORE (fixed-template fallback)</th><th class="ah">AFTER (Claude Opus 4.6)</th></tr></thead>
    <tbody>{body_rows}</tbody>
  </table>
</section>""")

    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Content comparison — {esc(client.get('clientName',''))}</title>
<style>
  body {{ font-family: -apple-system, Inter, sans-serif; max-width: 1400px; margin: 40px auto; padding: 0 20px; color:#222; line-height: 1.5; }}
  h1 {{ font-size: 32px; letter-spacing: -0.5px; }}
  h2 {{ font-size: 22px; margin-top: 36px; color:#111; border-bottom: 2px solid #ddd; padding-bottom: 6px; }}
  table {{ width: 100%; border-collapse: collapse; table-layout: fixed; }}
  th, td {{ vertical-align: top; padding: 10px 12px; border-bottom: 1px solid #eee; font-size: 14px; }}
  th {{ text-align: left; background: #fafafa; font-weight: 600; }}
  th.bh {{ color:#c43; background: #fff4f0; }}
  th.ah {{ color:#161; background: #f0faf3; }}
  td.k {{ font-family: SF Mono, Menlo, monospace; font-size: 12px; color:#666; width: 180px; white-space: nowrap; }}
  td.b {{ color:#933; background: #fffbfa; white-space: pre-wrap; word-break: break-word; }}
  td.a {{ color:#161; background: #f8fbf8; white-space: pre-wrap; word-break: break-word; }}
  em {{ color:#aaa; font-style: italic; }}
  .meta {{ background:#f5f5f5; padding:14px 18px; border-radius:8px; margin:12px 0 28px; font-size:14px; }}
  .pills {{ display:flex; flex-wrap:wrap; gap:6px; margin:12px 0; }}
  .pill {{ padding:4px 10px; border-radius:999px; font-size:12px; font-family: SF Mono, Menlo, monospace; }}
  .pill-in {{ background:#dff5e0; color:#1a6b33; border:1px solid #a3dfae; }}
  .pill-out {{ background:#eee; color:#999; border:1px solid #ddd; text-decoration:line-through; }}
  .rationale {{ margin-top:14px; padding:12px 14px; background:#f0faf3; border-left:4px solid #1a6b33; border-radius:4px; font-size:14px; }}
  .selection-section {{ background:#fff; border:2px solid #d0e8d3; border-radius:10px; padding:18px 20px; margin-bottom:28px; }}
  .tag {{ font-size:11px; padding:2px 8px; border-radius:4px; font-weight:600; margin-left:8px; vertical-align:middle; }}
  .tag-in {{ background:#dff5e0; color:#1a6b33; }}
  .tag-out {{ background:#eee; color:#888; }}
  .brief-block {{ background:#fff5e0; border-left:4px solid #d68c00; border-radius:4px; padding:12px 14px; margin-top:10px; font-size:14px; }}
</style></head><body>
<h1>Proposal content — {esc(client.get('clientName',''))}</h1>
<div class="meta">
  <b>Industry:</b> {esc(client.get('industry','—'))}<br>
  <b>Use case:</b> {esc(client.get('useCase','—'))}<br>
  <b>Mascot:</b> {esc(client.get('mascotName','—'))} &nbsp;|&nbsp;
  <b>Brand:</b> {esc(client.get('color1hex','—'))} &nbsp;|&nbsp;
  <b>Language:</b> {esc(client.get('outputLang','en'))}<br>
  <b>Before</b> = what the system currently renders when Claude is not used (hardcoded fallbacks).<br>
  <b>After</b>  = Claude Opus 4.6 read the client description, <b>chose which slides to include</b>, and wrote tailored copy.
  {f'<div class="brief-block"><b>Brief:</b> {esc(brief)}</div>' if brief else ''}
</div>
{''.join(sections)}
</body></html>"""
    return html


def main():
    p = argparse.ArgumentParser()
    p.add_argument('fixture', help='Path to client fixture JSON')
    p.add_argument('--brief', default='', help='Optional pitch-specific brief (free text)')
    p.add_argument('--compare', action='store_true', help='Emit side-by-side HTML to stdout')
    p.add_argument('--out', default=None, help='Write HTML output to file instead of stdout')
    args = p.parse_args()

    with open(args.fixture) as f:
        client = json.load(f)

    prompt = build_prompt(client, brief=args.brief)
    print(f'→ Calling Claude Opus 4.6 for {client.get("clientName")}'
          + (f' (with brief)' if args.brief else ''), file=sys.stderr)
    after_full = call_claude(prompt)
    before = before_output(client)

    selected = after_full.get('selected_slides', [])
    print(f'  ✓ AI selected {len(selected)}/18 slides: {", ".join(selected)}', file=sys.stderr)

    if args.compare:
        html = render_compare_html(client, before, after_full, brief=args.brief)
        if args.out:
            with open(args.out, 'w') as f:
                f.write(html)
            print(f'→ Wrote {args.out}', file=sys.stderr)
        else:
            sys.stdout.write(html)
    else:
        out = {'before': before, 'after': after_full, 'client': client, 'brief': args.brief}
        json.dump(out, sys.stdout, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
