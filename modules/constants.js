export const MODULE_NAME = "BB-Visual-Novel";
export const DEFAULT_IMPACT_VALUES = {
    unforgivable: -20,
    major_negative: -8,
    minor_negative: -2,
    none: 0,
    minor_positive: 2,
    major_positive: 8,
    life_changing: 20,
};
export const DEFAULT_SETTINGS = {
    autoSend: true,
    autoGen: false,
    useCustomApi: false,
    customApiUrl: 'https://api.groq.com/openai/v1',
    customApiKey: '',
    customApiModel: '',
    useMacro: false,
    emotionalChoiceFraming: true,
    disableRelationshipTracker: false,
    vnReplyLength: 'medium',
    friendshipImpactValues: { ...DEFAULT_IMPACT_VALUES },
    romanceImpactValues: { ...DEFAULT_IMPACT_VALUES },
};

export function normalizeVnReplyLength(value = '') {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'short' || normalized === 'medium' || normalized === 'long') {
        return normalized;
    }
    return DEFAULT_SETTINGS.vnReplyLength;
}

export function normalizeImpactValue(value, fallback = 0) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.max(-100, Math.min(100, parsed));
}

export function normalizeImpactSettings(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(
        Object.entries(DEFAULT_IMPACT_VALUES).map(([key, fallback]) => [
            key,
            normalizeImpactValue(source[key], fallback),
        ]),
    );
}

export function resolveImpactScaleSettings(settings = {}) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const legacyImpactValues = normalizeImpactSettings(source.impactValues);
    return {
        friendshipImpactValues: normalizeImpactSettings(source.friendshipImpactValues ?? legacyImpactValues),
        romanceImpactValues: normalizeImpactSettings(source.romanceImpactValues ?? legacyImpactValues),
    };
}

export const SOCIAL_PROMPT = `[SYSTEM INSTRUCTION: VISUAL NOVEL ENGINE]
You are tracking how the characters feel about {{user}}.
At the VERY END of your response, you MUST generate a hidden HTML block evaluating how {{user}}'s last action affected the characters.

CRITICAL RULES:
1. ONLY evaluate characters actively present or directly reacting in this specific turn.
2. NEVER create a social update for {{user}}, the protagonist, the player, the narrator, or the user's persona. Track only other characters.
3. Keep tag names EXACTLY as written in English. Translate ONLY the values into Russian.
4. To prevent conflicts with other JSON in messages, you MUST wrap updates inside a hidden HTML block exactly like this:

<div style="display: none;" class="bb-vn-data">
  <bb-social-updates>
    <bb-social-update>
      <name>CHARACTER_NAME</name>
      <friendship_impact>minor_positive</friendship_impact>
      <romance_impact>none</romance_impact>
      <user_label>\u041a\u0415\u041c_USER_\u0421\u0422\u0410\u041b_\u0414\u041b\u042f_\u041d\u0418\u0425</user_label>
      <reason>\u041a\u0440\u0430\u0442\u043a\u0430\u044f \u043f\u0440\u0438\u0447\u0438\u043d\u0430 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f</reason>
      <emotion>\u044d\u043c\u043e\u0446\u0438\u044f</emotion>
    </bb-social-update>
  </bb-social-updates>
</div>

5. NEVER wrap any other part of the assistant reply in hidden HTML. Only the social block above can be hidden.
6. Do not hide, alter, or rewrite user-provided regex, code, JSON, or text fragments.
6a. NEVER replace <bb-social-updates> or <bb-social-update> with alternative tags such as <character>, <relationship>, or <update>.
7. Record a relationship update ONLY when {{user}} created a genuinely NEW relational beat in this turn. Ongoing presence in the same room, continued comfort, repeated closeness, or the same unresolved mood is NOT a new shift by itself.
8. If this turn only continues the same emotional beat as the previous turns, prefer "none" impacts instead of restating the same reason.
9. Never repeat the same <reason> on consecutive turns for the same character with only a different <emotion>. If the cause has not meaningfully changed, do not describe it as a new update.
10. <user_label> is NOT the character's job, title, class, personality, or self-image. It is ONLY how this character labels {{user}} in their mind.

HTML TAG FIELDS (STRICT):
- <name> Concrete character name. (e.g., "Alex"). No collective nouns.
- <name> MUST NOT be {{user}}, the user's persona name, "User", "Player", "Protagonist", "пользователь", "игрок", "протагонист", "герой", or any name belonging to the user.
- Do NOT translate the token values for <friendship_impact> and <romance_impact>. Keep those exact enum tokens in English.
- <friendship_impact> Choose strictly from: "none", "minor_positive", "major_positive", "life_changing", "minor_negative", "major_negative", "unforgivable".
- <romance_impact> Same scale as above. STRICT RULE: Keep "none" for casual/combat/platonic scenes.
- If the character genuinely likes, welcomes, enjoys, or is emotionally drawn to {{user}}'s action, do NOT lower friendship/trust at the same time as a positive romance shift.
- Use friendship negative + romance positive ONLY for clearly conflicted or dark attraction: fear mixed with desire, dangerous fascination, toxic obsession, shame, manipulation, coercion, or "drawn in despite the harm".
- <user_label> 1-2 words describing {{user}}'s CURRENT relationship label FROM THIS CHARACTER'S POINT OF VIEW (e.g., "\u043e\u043f\u0430\u0441\u043d\u044b\u0439 \u0441\u043e\u044e\u0437\u043d\u0438\u043a", "\u0441\u043a\u0440\u044b\u0442\u0430\u044f \u0443\u0433\u0440\u043e\u0437\u0430", "\u043d\u0430\u0434\u0451\u0436\u043d\u044b\u0439 \u0434\u0440\u0443\u0433", "\u043e\u0431\u043c\u0430\u043d\u0443\u0432\u0448\u0438\u0439 \u0447\u0443\u0436\u0430\u043a").
- <user_label> MUST answer: "\u043a\u0435\u043c {{user}} \u0441\u0442\u0430\u043b \u0434\u043b\u044f <name>?" It must NOT answer: "\u043a\u0442\u043e <name> \u0442\u0430\u043a\u043e\u0439?" or "\u0447\u0442\u043e <name> \u0447\u0443\u0432\u0441\u0442\u0432\u0443\u0435\u0442?"
- Before writing <user_label>, silently replace it into this sentence: "<name> now sees {{user}} as ___." If the sentence would describe <name> instead of {{user}}, rewrite it.
- <user_label> may include {{user}}'s actual persona role/profession ONLY if it describes how <name> sees {{user}}. For example, if {{user}} is truly a guard, "\u043d\u0435\u043d\u0430\u0434\u0451\u0436\u043d\u044b\u0439 \u0441\u0442\u0440\u0430\u0436" can be valid. If <name> is a caring aunt, do NOT write "\u0437\u0430\u0431\u043e\u0442\u043b\u0438\u0432\u0430\u044f \u0442\u0451\u0442\u043a\u0430"; write what {{user}} became to her instead, such as "\u043b\u044e\u0431\u0438\u043c\u044b\u0439 \u043f\u043b\u0435\u043c\u044f\u043d\u043d\u0438\u043a", "\u0431\u0435\u0441\u043f\u043e\u043a\u043e\u0439\u043d\u044b\u0439 \u043f\u043e\u0434\u043e\u043f\u0435\u0447\u043d\u044b\u0439", or "\u0443\u043f\u0440\u044f\u043c\u044b\u0439 \u0440\u0435\u0431\u0451\u043d\u043e\u043a".
- <reason> Short Russian explanation of WHY the NEW impact happened in this turn. Describe the fresh trigger, not the general situation.
- <emotion> 1-2 words describing the character's internal emotional state. If using two nouns, separate with a comma (e.g., "\u0448\u043e\u043a, \u043e\u0431\u0438\u0434\u0430", "\u0440\u0430\u0434\u043e\u0441\u0442\u044c").`;

export const OPTIONS_PROMPT = `Analyze the recent chat. Generate exactly 3 highly distinct, engaging actions {{user}} can take right now to DRIVE THE STORY FORWARD.

CRITICAL: Your generated messages MUST logically continue from the VERY LAST sentence of the [IMMEDIATE TRIGGER]. Do not ignore the character's final question, movement, or action. React directly to it.

For EACH action, write a roleplay message from {{user}}'s perspective. The message must actively move the scene, show initiative, and match {{user}}'s persona perfectly. Write in Russian and obey the active length directive exactly.

CRITICAL RULES FOR EMOTIONAL CHOICE FRAMING:
1. "tone": Describe the emotional flavor of the answer in 1-2 Russian words. Think in placeholder terms like "SHORT_RUSSIAN_TONE".
2. The "tone" MUST strongly affect the actual "message": vocabulary, body language, pacing, initiative, and inner monologue must all feel saturated with that tone.
3. The 3 options must differ not only by action idea, but also by emotional delivery. Avoid producing three options that all feel emotionally similar.
4. "forecast": A SHORT Russian hint for what this action may cause. Keep it compact: ideally 3-9 words and usually no longer than about 65 characters. Think in placeholder terms like "SHORT_RUSSIAN_OUTCOME_HINT".
5. "forecast" must logically match the tone and action. Do not write a soft forecast for an aggressive action or vice versa.
6. Prefer vivid, readable tones such as "\u043d\u0435\u0436\u043d\u043e", "\u0434\u0435\u0440\u0437\u043a\u043e", "\u0445\u043e\u043b\u043e\u0434\u043d\u043e", "\u043e\u043f\u0430\u0441\u043d\u043e", "\u0438\u0440\u043e\u043d\u0438\u0447\u043d\u043e", "\u0443\u044f\u0437\u0432\u0438\u043c\u043e", "\u043d\u0430\u043f\u043e\u0440\u0438\u0441\u0442\u043e", "\u043b\u0430\u0441\u043a\u043e\u0432\u043e", "\u0436\u0451\u0441\u0442\u043a\u043e" when they fit.
7. If the scene allows it, make the tones meaningfully contrast with each other.
8. "targets": Array of 1-3 character names that are most affected by this action. If no single character stands out, return an empty array.
9. "risk": OPTIONAL legacy field for backward compatibility. If you include it, use "\u041d\u0438\u0437\u043a\u0438\u0439", "\u0421\u0440\u0435\u0434\u043d\u0438\u0439", or "\u0412\u044b\u0441\u043e\u043a\u0438\u0439". Do not make it the main focus.
10. "intent": Must be a natural Russian phrase (2-5 words), compact and button-friendly. Prefer roughly 2-4 words and avoid stretching beyond ~42 characters. Never use placeholders, ALL_CAPS tokens, snake_case, or English-only labels.

CRITICAL JSON AND FORMATTING RULES:
1. Return STRICTLY a valid JSON array. DO NOT output any conversational text outside the JSON.
2. INSIDE the "message" field, you MUST use standard roleplay formatting: asterisks for *actions/thoughts* and quotes for dialogue.
3. If you need literal double quotes inside "message", ALWAYS escape them as \\".
4. Every "message" value MUST be a valid JSON-escaped string literal. Never insert raw line breaks inside the string; use only escaped sequences like \\n or \\n\\n.
5. NEVER include comments (// or /* */), markdown fences, or any extra text before/after the array.
6. To create paragraphs, use escaped newlines (\\n\\n) inside the "message" string. DO NOT use actual line breaks in the string, or it will break the JSON.
7. Each option must be clearly different in intent from the others. Never output near-duplicates with only wording changes.

Use this SHORT JSON SHAPE as a template. The placeholders below are instructions, not literal values. Return exactly 3 objects with this structure:
[
  {
    "intent": "SHORT_ACTION_LABEL",
    "tone": "SHORT_RUSSIAN_TONE",
    "forecast": "SHORT_RUSSIAN_OUTCOME_HINT",
    "targets": ["MOST_AFFECTED_CHARACTER"],
    "risk": "OPTIONAL_RISK_LABEL",
    "message": "LONG_RUSSIAN_ROLEPLAY_REPLY_WITH_ESCAPED_QUOTES_AND_\\n\\n_PARAGRAPHS"
  }
]

[STRUCTURED STORY CONTEXT]:
<context>
Protagonist: {{user}} ({{persona}})
Scene: {{authorsNote}}
Story Summary: {{summary}}
</context>

[RECENT CONTEXT (For background)]:
"""{{chat}}"""

[IMMEDIATE TRIGGER (You MUST directly respond to the exact ending of this message)]:
"""{{lastMessage}}"""`;

export const TOAST_LIFETIME_MS = 8500;
export const TOAST_MAX_VISIBLE = 4;
