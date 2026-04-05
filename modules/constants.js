export const MODULE_NAME = "BB-Visual-Novel";
export const DEFAULT_SETTINGS = {
    autoSend: true,
    autoGen: false,
    useCustomApi: false,
    customApiUrl: 'https://api.groq.com/openai/v1',
    customApiKey: '',
    customApiModel: '',
    useMacro: false,
    emotionalChoiceFraming: true,
};

export const SOCIAL_PROMPT = `[SYSTEM INSTRUCTION: VISUAL NOVEL ENGINE]
You are tracking how the characters feel about {{user}}. 
At the VERY END of your response, you MUST generate a hidden HTML block evaluating how {{user}}'s last action affected the characters.

CRITICAL RULES:
1. ONLY evaluate characters actively present or directly reacting in this specific turn.
2. Keep tag names EXACTLY as written in English. Translate ONLY the values into Russian.
3. To prevent conflicts with other JSON in messages, you MUST wrap updates inside a hidden HTML block exactly like this:

<div style="display: none;" class="bb-vn-data">
  <bb-social-updates>
    <bb-social-update>
      <name>CHARACTER_NAME</name>
      <friendship_impact>minor_positive</friendship_impact>
      <romance_impact>none</romance_impact>
      <role_dynamic>ОТНОШЕНИЕ_К_USER</role_dynamic>
      <reason>Краткая причина изменения</reason>
      <emotion>эмоция</emotion>
    </bb-social-update>
  </bb-social-updates>
</div>

4. NEVER wrap any other part of the assistant reply in hidden HTML. Only the social block above can be hidden.
5. Do not hide, alter, or rewrite user-provided regex, code, JSON, or text fragments.

HTML TAG FIELDS (STRICT):
- <name> Concrete character name. (e.g., "Alex"). No collective nouns.
- Do NOT translate the token values for <friendship_impact> and <romance_impact>. Keep those exact enum tokens in English.
- <friendship_impact> Choose strictly from: "none", "minor_positive", "major_positive", "life_changing", "minor_negative", "major_negative", "unforgivable".
- <romance_impact> Same scale as above. STRICT RULE: Keep "none" for casual/combat/platonic scenes.
- <role_dynamic> 1-2 words describing {{user}}'s CURRENT role to them right now (e.g., "опасный союзник", "скрытая угроза", "надежный друг").
- <reason> Short Russian explanation of WHY the impact happened.
- <emotion> 1-2 words describing the character's internal emotional state. If using two nouns, separate with a comma (e.g., "шок, обида", "радость").`;

export const OPTIONS_PROMPT = `Analyze the recent chat. Generate exactly 3 highly distinct, engaging actions {{user}} can take right now to DRIVE THE STORY FORWARD.

CRITICAL: Your generated messages MUST logically continue from the VERY LAST sentence of the [IMMEDIATE TRIGGER]. Do not ignore the character's final question, movement, or action. React directly to it!

For EACH action, write a LONG, HIGHLY DETAILED roleplay message (2-4 paragraphs) from {{user}}'s perspective. Include rich sensory details, deep internal monologues, and complex actions. DO NOT just react passively; make {{user}} take initiative to progress the plot or shift the dynamic. Match {{user}}'s persona perfectly. Write in Russian.

CRITICAL RULES FOR EMOTIONAL CHOICE FRAMING:
1. "tone": Describe the emotional flavor of the answer in 1-2 Russian words. Think in placeholder terms like "SHORT_RUSSIAN_TONE".
2. "forecast": A SHORT Russian hint for what this action may cause. Think in placeholder terms like "SHORT_RUSSIAN_OUTCOME_HINT".
3. "targets": Array of 1-3 character names that are most affected by this action. If no single character stands out, return an empty array.
4. "risk": OPTIONAL legacy field for backward compatibility. If you include it, use "Низкий", "Средний", or "Высокий". Do not make it the main focus.
5. "intent": Must be a natural Russian phrase (2-5 words). Never use placeholders, ALL_CAPS tokens, snake_case, or English-only labels.

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

[USER PERSONA REFERENCE]:
{{persona}}

[RECENT CONTEXT (For background)]:
"""{{chat}}"""

[IMMEDIATE TRIGGER (You MUST directly respond to the exact ending of this message)]:
"""{{lastMessage}}"""`;

export const TOAST_LIFETIME_MS = 8500;
export const TOAST_MAX_VISIBLE = 4;
