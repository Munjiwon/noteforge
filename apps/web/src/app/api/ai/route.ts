import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "db";

const SYSTEM = "You are a helpful assistant inside a Notion-style workspace. Reply concisely.";

function stripBlockNoteJson(json: string): string {
  try {
    const blocks = JSON.parse(json) as unknown;
    if (!Array.isArray(blocks)) return "";
    const parts: string[] = [];
    const walk = (b: unknown) => {
      if (!b || typeof b !== "object") return;
      const node = b as { content?: unknown; children?: unknown };
      const c = node.content;
      if (Array.isArray(c)) {
        for (const it of c) {
          if (
            it &&
            typeof it === "object" &&
            "text" in it &&
            typeof (it as { text: unknown }).text === "string"
          ) {
            parts.push((it as { text: string }).text);
          }
        }
      }
      if (Array.isArray(node.children)) for (const ch of node.children) walk(ch);
    };
    for (const b of blocks) walk(b);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

async function buildWorkspaceContext(
  workspaceSlug: string,
  userId: string,
  question: string,
): Promise<{ context: string; sources: { id: string; title: string }[] } | null> {
  const ws = await prisma.workspace.findUnique({
    where: { slug: workspaceSlug },
    include: { members: { where: { userId } } },
  });
  if (!ws || ws.members.length === 0) return null;
  // Tokenize the question for a poor-man's relevance match.
  const tokens = Array.from(
    new Set(
      question
        .toLowerCase()
        .split(/\W+/)
        .filter((t) => t.length >= 3),
    ),
  ).slice(0, 8);
  const where: Record<string, unknown> = {
    workspaceId: ws.id,
    deletedAt: null,
    kind: "doc",
  };
  if (tokens.length > 0) {
    (where as { OR?: unknown[] }).OR = tokens.flatMap((t) => [
      { title: { contains: t } },
      { content: { contains: t } },
    ]);
  }
  const pages = await prisma.page.findMany({
    where: where as never,
    take: 8,
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, content: true },
  });
  if (pages.length === 0) return { context: "", sources: [] };
  let context = "";
  const sources: { id: string; title: string }[] = [];
  for (const p of pages) {
    const txt = stripBlockNoteJson(p.content).slice(0, 1200);
    if (!txt) continue;
    context += `\n\n## ${p.title || "Untitled"}\n${txt}`;
    sources.push({ id: p.id, title: p.title || "Untitled" });
    if (context.length > 10_000) break;
  }
  return { context: context.trim(), sources };
}

const ACTION_PROMPT: Record<string, (text: string, instr?: string) => string> = {
  summarize: (text) => `Summarize the following in 2-3 sentences:\n\n${text}`,
  translate: (text, instr) =>
    instr
      ? `Translate the following to ${instr}, preserving meaning and tone. Reply with the translation only:\n\n${text}`
      : `Translate the following to Korean (or to English if it's already Korean):\n\n${text}`,
  improve: (text) => `Rewrite the following more clearly, keep the same meaning:\n\n${text}`,
  continue: (text) =>
    `You are continuing the following text. Write 2-4 sentences that flow naturally from where it ends. Match the tone and language. Do not repeat the existing text.\n\n${text}`,
  edit: (text, instr) =>
    `Apply this instruction to the text below, returning only the revised text (no preamble):\n\nInstruction: ${instr ?? "Improve."}\n\nText:\n${text}`,
  title: (text) =>
    `Suggest a single short title (under 60 chars) for the document below. Reply with the title text only, no quotes, no period.\n\n${text}`,
  one_liner: (text) =>
    `Compress the following into a single concise sentence. Reply with the sentence only.\n\n${text}`,
  explain: (text) =>
    `Explain the following in plain language, expanding on terms and assumptions a beginner might miss. 2-4 sentences.\n\n${text}`,
  keywords: (text) =>
    `Extract 5-7 short keywords or topics that describe the following document. Reply as a comma-separated list, no quotes, no preamble.\n\n${text}`,
  proofread: (text) =>
    `Fix grammar, spelling, and punctuation in the following text. Change wording only when strictly necessary. Reply with the corrected text only.\n\n${text}`,
  outline: (text) =>
    `Create a short hierarchical outline (markdown headings/bullets) of the following document. Reply with only the outline.\n\n${text}`,
  email: (text) =>
    `Write a concise, friendly email draft (3-5 sentences) about the following context. Include a subject line on the first line, blank line, then the body.\n\nContext:\n${text}`,
  ideas: (text) =>
    `Brainstorm 5 short, varied ideas inspired by the following context. Reply as a markdown bullet list, one idea per line, no preamble.\n\n${text}`,
  checklist: (text) =>
    `Extract a concrete to-do checklist (3-7 items) from the following context. Reply with a markdown checklist using '- [ ]' on each line, no preamble.\n\n${text}`,
  poll: (text) =>
    `Draft a short poll question with 3-4 multiple-choice options based on the context. Reply with the question first, then one option per line as '- option'.\n\n${text}`,
  action_items: (text) =>
    `Extract concrete action items from the following text. Reply only with markdown checkboxes (- [ ] …), 3-8 lines, no preamble.\n\n${text}`,
  quote: (text) =>
    `Pick 2-3 most memorable or quote-worthy sentences from the following text. Reply as markdown blockquote lines (each prefixed with '> ').\n\n${text}`,
  tone: (text, instr) =>
    `Rewrite the following text in a ${instr ?? "neutral"} tone, keeping the meaning. Reply with just the rewritten text.\n\n${text}`,
  longer: (text) =>
    `Expand the following text so it is roughly twice as long. Keep the meaning and tone intact. Reply with just the expanded text.\n\n${text}`,
  shorter: (text) =>
    `Compress the following text to roughly half its length, keeping all key meaning. Reply with just the compressed text.\n\n${text}`,
  glossary: (text) =>
    `Identify 5-8 key terms in the following text and define each in one short sentence. Reply as markdown bullets formatted as '- **term**: definition'.\n\n${text}`,
  sentiment: (text) =>
    `Classify the overall tone of the text below as Positive, Neutral, or Negative, then give a one-sentence reason. Reply as 'Label: reason'.\n\n${text}`,
  next_steps: (text) =>
    `Given the context, suggest 3-5 concrete next steps. Reply as a markdown numbered list, no preamble.\n\n${text}`,
  critique: (text) =>
    `Provide a constructive critique of the following text. Reply as markdown with two sections: '**Strengths**' and '**Improvements**', each with 2-3 bullets.\n\n${text}`,
  agenda: (text) =>
    `Draft a meeting agenda based on the context below. Reply as a markdown numbered list of 3-5 agenda items, each one short line. No preamble.\n\nContext:\n${text}`,
  eli5: (text) =>
    `Explain the following so a 5-year-old could understand it. Use short sentences and a friendly analogy. 2-4 sentences.\n\n${text}`,
  pros_cons: (text) =>
    `Analyze the topic below. Reply as markdown with two sections: '**Pros**' (3 bullets) and '**Cons**' (3 bullets).\n\nTopic:\n${text}`,
  risks: (text) =>
    `Identify 3-5 concrete risks or failure modes in the context below. Reply as markdown bullets, each with the risk and a brief mitigation hint after a dash.\n\n${text}`,
  timeline: (text) =>
    `Extract the events from the text below and arrange them in chronological order. Reply as a markdown bullet list, each line formatted '- <when>: <what>'. If a date is unclear, write 'Unknown'.\n\n${text}`,
  faq: (text) =>
    `Generate 3-5 frequently asked questions a reader might have about the context below, and answer each in one short sentence. Reply as markdown with '**Q:**' / '**A:**' pairs.\n\n${text}`,
  counter: (text) =>
    `Write 3-5 strong counter-arguments to the claims in the text below. Reply as a markdown bullet list, each starting with the counter-claim and a brief justification.\n\n${text}`,
  hashtags: (text) =>
    `Suggest 5-8 short hashtags (no spaces, lowercase, prefixed with #) summarizing the context below. Reply as a single line, space-separated.\n\n${text}`,
  headlines: (text) =>
    `Suggest 5 alternative headlines (each under 70 characters) for the context below. Reply as a markdown numbered list, no preamble, no quotes.\n\n${text}`,
  slug: (text) =>
    `Suggest a short, lowercase, hyphenated URL slug (max 5 words) describing the document below. Reply with the slug only — no path, no quotes.\n\n${text}`,
  tweet_thread: (text) =>
    `Write a Twitter/X thread of 3-5 posts based on the context. Each post under 280 characters. Reply as a markdown numbered list (1., 2., …). No hashtags unless natural.\n\n${text}`,
  citations: (text) =>
    `Identify the main factual claims in the text. For each, label whether it likely needs an external citation ('needs source') or is opinion/uncontroversial ('no source needed'). Reply as a markdown bullet list formatted '- <claim> — <label>'.\n\n${text}`,
  study_notes: (text) =>
    `Convert the text into concise study notes. Reply with markdown: a '**Key terms**' bullet list (term — definition) then a '**Highlights**' bullet list of the most important facts.\n\n${text}`,
  flashcards: (text) =>
    `Generate 5 flashcards from the context. Reply as markdown with each card as 'Q: <question>' on one line and 'A: <answer>' on the next, separated by a blank line.\n\n${text}`,
  quiz: (text) =>
    `Write a short 3-question multiple-choice quiz from the context. Each question has 3-4 lettered options (A. B. C. …). At the end, list the answers as 'Answers: 1-B, 2-A, 3-C'.\n\n${text}`,
  persona: (text) =>
    `Draft a user persona based on the context. Reply as markdown with bolded fields: **Name**, **Role**, **Goals**, **Pain points**, **Channels**. Keep each field to 1-2 short lines.\n\n${text}`,
  swot: (text) =>
    `Run a SWOT analysis on the topic below. Reply as markdown with four bolded sections: **Strengths**, **Weaknesses**, **Opportunities**, **Threats**, each with 2-3 bullets.\n\nTopic:\n${text}`,
  release_notes: (text) =>
    `Rewrite the following changes as user-facing release notes. Use markdown with sections '**✨ New**', '**🛠 Fixed**', '**⚠️ Notes**' (omit sections with no items). Keep bullets short.\n\nChanges:\n${text}`,
  objections: (text) =>
    `List 3-5 likely objections a stakeholder might raise about the context below, and a one-line response for each. Reply as markdown bullets '- **Objection:** … / **Response:** …'.\n\n${text}`,
  decision_log: (text) =>
    `Extract decisions discussed in the text. Reply as a markdown table with columns | Decision | Rationale | Alternatives considered |, one row per decision (max 5).\n\n${text}`,
  user_stories: (text) =>
    `Write 5 user stories based on the context. Use the format '- As a <persona>, I want <capability>, so that <benefit>.'  No preamble.\n\n${text}`,
  test_cases: (text) =>
    `Generate 5 BDD-style test cases from the context. Use markdown bullets formatted '- **Given** … **When** … **Then** …'.\n\n${text}`,
  rhyme: (text) =>
    `Rewrite the text below as a short rhyming poem (4-8 lines), preserving the core meaning. Reply with only the poem.\n\n${text}`,
  lyrics: (text) =>
    `Write a 4-line song lyric inspired by the context. Casual, singable. Reply with only the 4 lines.\n\n${text}`,
  regex: (text) =>
    `Treat the text below as a natural-language description. Reply with a single regular expression that matches it (PCRE-flavored). After the regex, on a new line, briefly explain it in one sentence.\n\nDescription:\n${text}`,
  sql: (text) =>
    `Treat the text below as a natural-language data question. Reply with a single SQL query (Postgres-compatible) inside a fenced \`\`\`sql block, then one sentence explaining it.\n\nQuestion:\n${text}`,
  commit_msg: (text) =>
    `Write a Conventional Commit message (e.g. 'feat: ...', 'fix: ...') summarizing the change description below. Reply with just the commit message — a 50-char subject line, optional blank line + body. No quotes.\n\n${text}`,
  standup: (text) =>
    `Write a daily standup note from the context. Reply as markdown with three bold sections: **Yesterday**, **Today**, **Blockers**, each with 2-3 short bullets.\n\nContext:\n${text}`,
  retro: (text) =>
    `Run a 4L retrospective on the context. Reply as markdown with four bold sections: **Liked**, **Learned**, **Lacked**, **Longed for**, each with 2-3 bullets.\n\nContext:\n${text}`,
  jargon: (text) =>
    `Find domain-specific jargon and acronyms in the text. Reply as a markdown bullet list formatted '- **term** — plain-language meaning'. 5-8 bullets max.\n\n${text}`,
  mind_map: (text) =>
    `Produce a mind-map of the topic below as a nested markdown bullet tree. Use the central topic on the first line, then 3-5 branches, each with 2-3 leaves. No preamble.\n\nTopic:\n${text}`,
  elevator_pitch: (text) =>
    `Write a 60-second elevator pitch (3-4 sentences) for the subject below. Compelling, jargon-light, ends with a call-to-action. Reply with just the pitch.\n\n${text}`,
  job_desc: (text) =>
    `Draft a job description for the role described below. Reply as markdown with bold sections: **About the role**, **Responsibilities** (3-5 bullets), **You bring** (3-5 bullets), **Nice to have** (2-3 bullets).\n\n${text}`,
  follow_up: (text) =>
    `Suggest 3 short follow-up questions or next-action prompts after the meeting/email below. Reply as a markdown numbered list, one short sentence each.\n\n${text}`,
  sub_headings: (text) =>
    `Suggest 5 short sub-headings that would naturally split the context below. Reply as a markdown numbered list, each under 60 chars, no quotes, no preamble.\n\nContext:\n${text}`,
  anti_pattern: (text) =>
    `Identify likely anti-patterns or pitfalls in the text. Reply as a markdown bullet list, each line as '- **anti-pattern** — why it hurts'.\n\n${text}`,
  dictionary: (text) =>
    `Build a mini dictionary for the 5-8 most important nouns or noun phrases in the text. Reply as markdown bullets formatted '- **word** /pronunciation if obvious/ — one-sentence definition'.\n\n${text}`,
  expand_acronyms: (text) =>
    `Find acronyms in the text. For each, show the expansion. Reply as markdown bullets '- ACR — Full Expansion (optional one-line meaning)'. If no acronyms, reply 'No acronyms found.'.\n\n${text}`,
  star_method: (text) =>
    `Rewrite the context using the STAR method. Reply as markdown with four bold sections: **Situation**, **Task**, **Action**, **Result**, each with 2-3 short bullets.\n\nContext:\n${text}`,
  key_takeaways: (text) =>
    `Extract 3-5 key takeaways from the text. Reply as a markdown bullet list, each bullet a single short sentence focused on the most actionable insight.\n\n${text}`,
  email_reply: (text) =>
    `Draft a polite, concise reply to the email/message below. 3-5 sentences. Begin with a brief acknowledgment, address the main point, propose next step, close warmly. Reply with the message body only (no subject line).\n\nIncoming:\n${text}`,
  cover_letter: (text) =>
    `Draft a short cover letter (3-4 paragraphs) for the role/context below. Open with a hook, summarize relevant strengths, close with availability and thanks. Reply with the body only.\n\nContext:\n${text}`,
  pre_publish: (text) =>
    `Generate a pre-publish quality checklist tailored to the content. Reply as 6-10 markdown checkboxes (- [ ] …), grouped under '**Content**', '**Editing**', '**Distribution**' bold subheadings as relevant.\n\nContent:\n${text}`,
  tagline: (text) =>
    `Suggest 5 short, punchy taglines (under 12 words each) for the context below. Reply as a markdown numbered list, no preamble.\n\n${text}`,
  metaphor: (text) =>
    `Explain the subject below using 3 distinct metaphors, each in 1-2 sentences. Reply as a markdown numbered list. No preamble.\n\nSubject:\n${text}`,
  press_release: (text) =>
    `Draft a short press release based on the context. Markdown with: a strong headline, a dateline line, a 2-3 sentence lead paragraph, a body paragraph, and a one-line boilerplate. Reply with the release only.\n\nContext:\n${text}`,
  interview_questions: (text) =>
    `Generate 5 thoughtful interview questions for the role/topic below. Mix behavioral and technical. Reply as a markdown numbered list, one question per line.\n\n${text}`,
  linkedin_post: (text) =>
    `Write a short LinkedIn post (90-180 words) from the context. Conversational, value-forward, ends with a question to invite comments. Reply with just the post.\n\n${text}`,
  blog_outline: (text) =>
    `Create a blog post outline. Reply as markdown: a working title, then 4-6 H2 sections each with 2-3 sub-bullets, then a short conclusion bullet. No preamble.\n\nTopic:\n${text}`,
  testimonials: (text) =>
    `Write 3 short, varied testimonials (1-2 sentences each) that could plausibly come from different personas (a customer, a peer, an expert). Reply as markdown bullets formatted '- "…" — Name, Title'.\n\nContext:\n${text}`,
  contrarian: (text) =>
    `Take a contrarian stance against the text below. Reply with 1 short headline, then 3-4 bullets justifying the opposing view.\n\n${text}`,
  dialog: (text) =>
    `Rewrite the context as a 2-person dialog (call the speakers A and B). 4-8 lines total. Each line on its own line, prefixed 'A:' or 'B:'.\n\n${text}`,
  seo_keywords: (text) =>
    `Suggest SEO keywords for the page below. Reply as markdown with two bold sections: **Primary keywords** (3-5 short phrases) and **Long-tail** (5-8 longer phrases). Each as bullets.\n\nPage:\n${text}`,
  news_headline: (text) =>
    `Write a news-style headline (under 90 chars) and a 1-2 sentence lead for the context. Reply as markdown: '**Headline:** …' on one line, then '**Lead:** …' on the next.\n\nContext:\n${text}`,
  recommendation_letter: (text) =>
    `Draft a short recommendation letter (3-4 short paragraphs) for the candidate described below. Open with the relationship, then 2 specific strengths with brief evidence, close with a confident endorsement.\n\nContext:\n${text}`,
  scenario: (text) =>
    `Project 3 scenarios from the context below. Reply as markdown with three bold sections: **Best case**, **Base case**, **Worst case**, each 2-3 bullets.\n\n${text}`,
  risk_matrix: (text) =>
    `Build a risk matrix from the context. Reply as a markdown table with columns | Risk | Likelihood (L/M/H) | Impact (L/M/H) | Mitigation |. 4-6 rows.\n\n${text}`,
  api_spec: (text) =>
    `Draft a minimal API spec for the endpoint described below. Reply as markdown with: method+path on first line, then '**Request**' (params/body) and '**Response**' (200, 4xx) sections. JSON examples in fenced code blocks.\n\n${text}`,
  raci: (text) =>
    `Produce a RACI table for the work described below. Reply as a markdown table with columns | Task | Responsible | Accountable | Consulted | Informed |. 4-6 rows.\n\n${text}`,
  value_prop: (text) =>
    `Write a value proposition canvas summary for the offering below. Reply as markdown with bold sections: **Customer jobs**, **Pains**, **Gains**, **Our products/services**, **Pain relievers**, **Gain creators**, each 2-3 bullets.\n\n${text}`,
  cta: (text) =>
    `Suggest 5 strong CTA button microcopy options (under 4 words each) for the context below. Reply as a markdown numbered list, no quotes.\n\n${text}`,
  landing_hero: (text) =>
    `Write landing page hero copy. Reply as markdown with bold labels: **Headline** (under 12 words), **Sub-head** (1-2 sentences), **Primary CTA** (3 words), **Secondary CTA** (3 words).\n\nContext:\n${text}`,
  onboarding_email: (text) =>
    `Write a friendly onboarding email (4-6 short sentences) to a new user/customer. Begin with welcome, highlight one quick win, end with a clear call-to-action. Subject line on the first line, blank, then body.\n\nContext:\n${text}`,
  insight_3: (text) =>
    `Extract the 3 most surprising or actionable insights from the text. Reply as a markdown numbered list, each insight in one sentence. No preamble.\n\n${text}`,
  dictation_clean: (text) =>
    `Treat the text below as a raw transcript. Add punctuation, fix dropped words, paragraph breaks, and remove filler ('um', 'like', repeated words) without changing meaning. Reply with the cleaned text only.\n\n${text}`,
  clean_formatting: (text) =>
    `Fix only the formatting of the text below: collapse multiple blank lines, normalize bullet markers to '- ', strip stray markdown that doesn't render correctly, remove trailing whitespace. Do NOT change wording. Reply with the cleaned version only.\n\n${text}`,
  inverse_pyramid: (text) =>
    `Rewrite the text in inverse-pyramid order: a single-sentence headline first, then a 2-3 sentence summary, then supporting details. Reply as markdown using bold labels '**Headline**', '**Summary**', '**Details**'.\n\n${text}`,
  contrast_vs: (text) =>
    `Identify the two main options in the context and compare them. Reply as a markdown table with columns | Aspect | Option A | Option B |, 4-6 rows.\n\n${text}`,
  buyer_persona: (text) =>
    `Create a buyer persona sheet for the offering below. Reply as markdown with bold sections: **Demographics**, **Goals**, **Pain points**, **Buying triggers**, **Objections**, **Preferred channels**, each with 2-3 bullets.\n\nContext:\n${text}`,
  feature_benefit: (text) =>
    `Convert the features listed in the text into a feature-vs-benefit table. Reply as a markdown table with columns | Feature | User benefit | Why it matters |, 4-6 rows.\n\n${text}`,
  learn_vocab: (text) =>
    `Pick 6-8 useful vocabulary words from the text. Reply as a markdown list where each item is '- **word** /pronunciation/ — definition. *Example: …*'.\n\n${text}`,
  business_canvas: (text) =>
    `Build a Lean Canvas summary for the venture below. Reply as markdown with bold sections: **Problem**, **Customer segments**, **Unique value proposition**, **Solution**, **Channels**, **Revenue streams**, **Cost structure**, **Key metrics**, **Unfair advantage**, each 2-3 short bullets.\n\nContext:\n${text}`,
  competitive_analysis: (text) =>
    `Identify likely competitors for the offering below and compare them. Reply as a markdown table with columns | Competitor | Strengths | Weaknesses | Our edge |, 3-5 rows. After the table, add one bold takeaway sentence.\n\nOffering:\n${text}`,
  postmortem: (text) =>
    `Draft an incident postmortem from the context. Markdown sections: **Summary**, **Timeline** (bulleted, with rough times), **Root cause**, **Impact**, **What went well**, **Action items** (- [ ] …).\n\nContext:\n${text}`,
  case_study: (text) =>
    `Write a short customer case study (250-350 words) using the context. Sections: **Challenge**, **Solution**, **Outcome** (with at least one quantitative result). End with a one-line client quote.\n\nContext:\n${text}`,
  customer_interview: (text) =>
    `Generate 8 customer-interview questions for the topic below. Mix open-ended discovery, behavior, and pain-point questions. Reply as a markdown numbered list, no preamble.\n\nTopic:\n${text}`,
  release_tweet: (text) =>
    `Write a single release-announcement tweet (under 280 chars) about the context. Hook in the first line, one concrete benefit, optional one short link placeholder. Reply with just the tweet text.\n\n${text}`,
  job_offer_email: (text) =>
    `Draft a warm job-offer email to the candidate described below. 4-5 short paragraphs: congratulations, role + start date, compensation summary, next steps, signature placeholder. Subject line on the first line, blank, then body.\n\n${text}`,
  spec_template: (text) =>
    `Produce a feature spec skeleton tailored to the context. Markdown sections: **Overview**, **Goals**, **Non-goals**, **User stories** (3 bullets), **UX flow** (2-3 bullets), **Open questions** (2 bullets), **Rollout** (1-2 bullets).\n\nContext:\n${text}`,
  okrs: (text) =>
    `Propose 1 quarterly Objective and 3 Key Results for the area below. Format the Objective in a single inspirational sentence; format each KR as a measurable bullet starting with a verb and a number.\n\nArea:\n${text}`,
  onboarding_checklist: (text) =>
    `Generate a 1-week onboarding checklist for a new hire in the context below. Reply as markdown checkboxes grouped under bold **Day 1**, **Days 2-3**, **End of Week 1**.\n\nContext:\n${text}`,
  prd: (text) =>
    `Draft a lightweight PRD skeleton for the feature below. Markdown sections: **Problem**, **Goals**, **Non-goals**, **Requirements** (must/should/nice as nested bullets), **Risks**, **Open questions**.\n\nFeature:\n${text}`,
  sales_pitch: (text) =>
    `Write a 60-second sales pitch for the offering below. 4-5 sentences. Lead with the customer pain, name the solution, share one proof point, close with a specific next step. Reply with just the pitch.\n\n${text}`,
  cold_email: (text) =>
    `Draft a short cold outreach email to the prospect described below. Subject line on the first line, blank, then body (4-5 sentences max). Personalize one sentence, name the value, suggest a 15-min call, close politely.\n\n${text}`,
  q_and_a: (text) =>
    `Reorganize the context as a Q&A document. Extract 4-6 likely questions a reader/buyer/team would ask, then provide direct answers grounded in the context. Reply as markdown with '**Q:**' and '**A:**' pairs.\n\n${text}`,
  agenda_action: (text) =>
    `Read the meeting context. For each agenda item, return both the item title and a one-line action that should result. Reply as a markdown table with columns | Agenda item | Action |, 3-5 rows.\n\n${text}`,
  escalation_email: (text) =>
    `Draft a calm, professional escalation email. 3-4 short paragraphs: state the issue and impact, summarize what's been tried, request specific help with a deadline, close politely. Subject line first, blank line, body.\n\nContext:\n${text}`,
  proposal: (text) =>
    `Write a one-page proposal for the work described. Markdown sections: **Background**, **Approach**, **Deliverables**, **Timeline**, **Investment**, **Why us** — each 2-3 bullets.\n\nContext:\n${text}`,
  roadmap: (text) =>
    `Build a product roadmap. Reply as markdown with three bold sections: **Now**, **Next**, **Later**, each containing 3-5 bullets phrased as user-visible outcomes.\n\nContext:\n${text}`,
  sprint_plan: (text) =>
    `Plan a 2-week sprint. Reply as markdown with bold sections: **Goal** (one sentence), **Stories** (4-6 bullets each with a rough size S/M/L), **Risks**, **Definition of done**.\n\nContext:\n${text}`,
  standup_async: (text) =>
    `Write a 3-line async standup note: line 1 'Yesterday: …', line 2 'Today: …', line 3 'Blockers: …'. Keep each line under 110 chars. No preamble.\n\nContext:\n${text}`,
  release_detailed: (text) =>
    `Produce detailed release notes from the changes below. Reply as markdown with bold sections: **🎉 Highlights** (1-3 bullets), **✨ New features**, **🛠 Improvements**, **🐛 Bug fixes**, **⚙ Technical notes** (skip empty sections).\n\nChanges:\n${text}`,
  code_review: (text) =>
    `Act as a senior engineer reviewing the code or change description below. Give 5 specific, constructive review comments. Each should call out a file/section reference (if obvious) and either a suggestion or a question. Reply as a markdown bullet list.\n\n${text}`,
  devil_advocate: (text) =>
    `Play devil's advocate against the text below. Give 5 sharp, well-reasoned challenges to its assumptions. Reply as a markdown numbered list, each item 1-2 sentences.\n\n${text}`,
  objection_handler: (text) =>
    `Anticipate 4-6 customer objections to the offering described below. For each, write a one-paragraph response that acknowledges the concern and reframes it. Reply as markdown bullets formatted '- **Objection:** … / **Response:** …'.\n\n${text}`,
  changelog_emoji: (text) =>
    `Rewrite the change list below as an emoji-tagged changelog. Markdown bullets, each prefixed with one emoji that fits the change type (✨ new, 🛠 improvement, 🐛 fix, ⚡ perf, 📚 docs, ♻️ refactor). Keep entries short.\n\n${text}`,
  inverse_faq: (text) =>
    `Treat the text below as a set of answers. Reverse-engineer the questions a reader would have asked to receive each answer. Reply as markdown '**Q:**' / '**A:**' pairs, 4-6 items, with the Q coming first.\n\n${text}`,
  style_guide: (text) =>
    `From the content below, infer a short content style guide. Reply as markdown with bold sections: **Voice**, **Tone**, **Do**, **Don't**, **Vocabulary preferences**, each 2-3 bullets.\n\n${text}`,
  email_friendly: (text) =>
    `Rewrite the email below to be warmer and more conversational without losing professionalism. Preserve all facts and asks. Reply with the rewritten email body only.\n\n${text}`,
  persona_quote: (text) =>
    `Imagine 3 short, characterful pull quotes (1-2 sentences each) different personas might say about the topic. Reply as markdown bullets formatted '- "…" — Persona type, in this voice'.\n\n${text}`,
  voice_script: (text) =>
    `Rewrite the context as a short voice-over script (60-90 seconds) — natural spoken cadence, no jargon, clear pauses (use '—'). Reply as plain prose paragraphs only.\n\n${text}`,
  short_bio: (text) =>
    `Write a short third-person professional bio (2-3 sentences, under 60 words) for the subject described below. Reply with the bio only.\n\n${text}`,
  long_bio: (text) =>
    `Write a longer professional bio (3 paragraphs, 150-220 words) for the subject described below. Cover background, current focus, notable accomplishments. Reply with the bio only.\n\n${text}`,
  job_rejection: (text) =>
    `Draft a respectful job-rejection email (4 sentences). Express thanks, keep it warm, give one piece of constructive encouragement, leave the door open. Subject line first, blank, then body.\n\n${text}`,
  recruiting_msg: (text) =>
    `Write a personalized LinkedIn-style recruiting message (under 600 chars). One sentence personalization, one line about the role + company, one ask for a 15-min chat. No emoji. Reply with the message only.\n\n${text}`,
  exec_summary: (text) =>
    `Write an executive summary (under 250 words) of the document below. Open with the key claim, surface the 3 most important facts, end with a single bold recommendation. Reply as 2-3 short paragraphs.\n\n${text}`,
  lessons_learned: (text) =>
    `From the context, extract a 'Lessons learned' note. Reply as markdown with two bold sections: **What worked** (3 bullets) and **What to change** (3 bullets), each a short, actionable insight.\n\n${text}`,
  decision_memo: (text) =>
    `Draft a decision memo for the choice described. Markdown sections: **Decision**, **Options considered** (2-3 bullets each), **Trade-offs**, **Recommendation**, **Owner / next step**.\n\n${text}`,
  release_faq: (text) =>
    `Write a launch-day FAQ for the release described. 5-7 Q&A pairs covering pricing, availability, migration, support, and risk. Reply as markdown '**Q:**' / '**A:**' pairs.\n\n${text}`,
  launch_checklist: (text) =>
    `Generate a product launch checklist tailored to the release. Reply as markdown checkboxes grouped under bold sections: **T-7 days**, **T-1 day**, **Launch day**, **T+1 day**.\n\n${text}`,
  feedback_questions: (text) =>
    `Write 5 sharp feedback questions for users of the offering below. Mix value, friction, and willingness-to-pay angles. Reply as a markdown numbered list, no preamble.\n\n${text}`,
  user_research_plan: (text) =>
    `Outline a user research plan for the topic below. Markdown sections: **Goals**, **Hypotheses**, **Methodology** (which methods + sample size), **Recruitment criteria**, **Key questions**, **Timeline**.\n\n${text}`,
  discovery_questions: (text) =>
    `Generate 8 open-ended discovery interview questions for the persona/topic. Avoid leading questions; favor 'tell me about a time…' style. Reply as a markdown numbered list.\n\n${text}`,
  product_tour: (text) =>
    `Write 5 product-tour tooltip captions for a new user. Each tooltip: a one-line headline, then a one-sentence call-to-action. Reply as markdown numbered items '1. **Headline** — CTA'.\n\nContext:\n${text}`,
  day_in_life: (text) =>
    `Write a 'day in the life' narrative (3-4 short paragraphs) for the persona described. Anchor to specific times of day, real tools used, and the moments where the offering would help. Reply as prose.\n\n${text}`,
  founder_story: (text) =>
    `Write a 200-280 word founder-story essay for the venture below. Start with a specific moment of frustration, name what changed, end with the mission. Reply as plain prose.\n\n${text}`,
  positioning: (text) =>
    `Write a single positioning statement using the template: 'For <segment> who <need>, <product> is the <category> that <differentiator>, unlike <alternative>.' Reply with just the filled-in sentence.\n\nContext:\n${text}`,
  ad_copy: (text) =>
    `Write 3 ad copy variants for the offering below: **Short** (under 90 chars), **Medium** (2 sentences), **Long** (4 sentences). Reply as markdown with bold labels.\n\n${text}`,
  headline_test: (text) =>
    `Generate 3 paired headline A/B tests for the topic. Each pair contrasts a different angle (benefit vs. fear, specific vs. broad, question vs. statement). Reply as markdown: '**Test 1:** A: … / B: …' etc.\n\n${text}`,
  before_after: (text) =>
    `Draft a Before/After comparison for the subject. Reply as markdown with two bold sections: **Before** (3-4 bullets describing the pain) and **After** (3-4 bullets describing the relief).\n\n${text}`,
  social_proof: (text) =>
    `Write 5 short social-proof microcopy lines for the offering (each under 90 chars). Mix customer count, ratings, named clients, and outcomes. Reply as a markdown bullet list.\n\n${text}`,
  error_msg: (text) =>
    `Rewrite the error condition below as a friendly user-facing error message. Markdown with bold labels: **Title** (under 10 words, calm tone), **Body** (1-2 sentences, what happened + what to try), **CTA** (3-word button label).\n\n${text}`,
  migration_guide: (text) =>
    `Draft a migration guide for the change described. Markdown sections: **Overview**, **Breaking changes**, **Step-by-step** (numbered), **Code diff example**, **Rollback plan**.\n\n${text}`,
  legal_disclaimer: (text) =>
    `Write a short, plain-language legal disclaimer paragraph for the context. Avoid jargon, stay neutral. Reply with the disclaimer paragraph only.\n\n${text}`,
  privacy_summary: (text) =>
    `Summarize the privacy practices described below into a 5-bullet plain-language summary the average user would understand. Reply as a markdown bullet list.\n\n${text}`,
  api_changelog: (text) =>
    `Write API changelog notes for the change list. Group by '**Added**', '**Changed**', '**Deprecated**', '**Removed**', '**Fixed**'. Each entry should mention the endpoint or symbol. Skip empty groups.\n\n${text}`,
  whitepaper_outline: (text) =>
    `Outline a B2B whitepaper on the topic. Markdown sections: **Title**, **Abstract** (3 sentences), **Why now**, **Problem**, **Solution**, **Evidence**, **Implementation**, **Conclusion**, **About the author**. Each section gets 1-3 bullet points.\n\n${text}`,
  press_quote: (text) =>
    `Write 3 short, plausible press quotes (1-2 sentences each) about the offering. Voice them as a **CEO** of the company, a **Customer**, and a notable **Investor / analyst**. Reply as markdown bullets formatted '- "…" — Name, Role'.\n\n${text}`,
  customer_quote: (text) =>
    `Write a single short customer pull-quote (1-2 sentences) suitable for a case study landing. Specific number or outcome included. Attribute it to a plausible job title. Reply with just the quote line in the format: "…" — First Last, Title.\n\n${text}`,
  content_calendar: (text) =>
    `Plan a 4-week content calendar for the topic. Reply as a markdown table with columns | Week | Theme | Asset(s) | Channel | Owner |, 4 rows (one per week).\n\nContext:\n${text}`,
  seo_meta: (text) =>
    `Suggest one SEO meta title (under 60 chars) and one meta description (under 155 chars) for the page below. Reply as markdown with bold labels.\n\n${text}`,
  alt_text: (text) =>
    `Write a concise alt-text description (under 125 chars) for the image described below. Focus on what's depicted, not metaphor. Reply with just the alt text.\n\nImage description:\n${text}`,
  thumbnail_text: (text) =>
    `Suggest 3 short thumbnail overlay phrases (3-5 words each, punchy) for the content below. Avoid clickbait. Reply as a markdown numbered list.\n\n${text}`,
  survey_design: (text) =>
    `Design a 5-question survey to learn about the topic. Mix at least one Likert scale, one multiple choice, and one open-ended question. Reply as markdown with the question type label in parens after each.\n\n${text}`,
  system_prompt: (text) =>
    `Write a robust 'system prompt' for an AI assistant that helps with the task below. Include: role, scope, tone, refusal cases, and a one-line example reply. Reply as plain prose paragraphs, not bullets.\n\nTask:\n${text}`,
  talking_points: (text) =>
    `Distill the context into 5 sharp speaker talking points (each one short sentence). Reply as a markdown numbered list, no preamble.\n\n${text}`,
  brief_from_bullets: (text) =>
    `Expand the bullet list below into 2-3 short, flowing paragraphs suitable for a stakeholder brief. Keep facts intact; smooth out connective phrasing.\n\n${text}`,
  haiku: (text) =>
    `Write a single haiku (3 lines, 5-7-5 syllables) inspired by the topic below. Reply with just the haiku, one line per line.\n\n${text}`,
  quotes_on_topic: (text) =>
    `List 5 famous quotes (real ones — historical figures or well-known authors) related to the topic. Reply as markdown bullets formatted '- "…" — Attributed Name'.\n\nTopic:\n${text}`,
  tldr_emoji: (text) =>
    `Write a single-line TL;DR (under 110 chars) of the context, starting with one fitting emoji. Reply with just the line, no preamble.\n\n${text}`,
  icebreaker: (text) =>
    `Suggest 3 lightweight icebreaker questions or activities suited to the meeting context below. Friendly, inclusive, under 1 minute each. Reply as a markdown numbered list.\n\n${text}`,
  one_on_one: (text) =>
    `Draft a manager↔direct-report 1:1 agenda. Markdown sections: **Wins** (3 bullets), **Blockers / asks**, **Feedback (both ways)**, **Growth focus**, **Action items** (- [ ] …).\n\nContext:\n${text}`,
  customer_pain: (text) =>
    `Identify 5 customer pain points implied by the context. For each, name the pain and the cost it incurs (time, money, frustration). Reply as a markdown bullet list.\n\n${text}`,
  pivot_options: (text) =>
    `Propose 3 plausible product/business pivot options from the context. For each: a one-sentence pivot description, the riskiest assumption, and one cheap experiment to test it. Reply as markdown headings + bullets.\n\n${text}`,
  risk_register: (text) =>
    `Produce a risk register table for the work below. Columns | Risk | Likelihood (L/M/H) | Impact (L/M/H) | Owner | Mitigation |. 4-6 rows.\n\n${text}`,
  team_charter: (text) =>
    `Draft a team charter from the context. Markdown sections: **Mission**, **Scope (in / out)**, **Operating principles** (3 bullets), **Decision rights**, **Cadence**, **Success metrics**.\n\n${text}`,
  values_statement: (text) =>
    `Draft 5 organizational values inspired by the context. For each: a 1-2 word name, a one-sentence definition, and a single example behavior. Reply as markdown bullets formatted '- **Value** — definition. *Example: …*'.\n\n${text}`,
  swot_personal: (text) =>
    `Run a personal SWOT for the individual described below. Markdown sections **Strengths**, **Weaknesses**, **Opportunities**, **Threats** (2-3 bullets each). Stay honest, not flattering.\n\n${text}`,
  career_pitch: (text) =>
    `Write a 90-second career elevator pitch (3-4 sentences) for the person below: who they are, what they're great at, what they're seeking, why now. Reply as plain prose.\n\n${text}`,
  resignation_letter: (text) =>
    `Draft a polite resignation letter (3 short paragraphs). Express thanks, state last day, offer help with the transition. Reply with the letter body only.\n\nContext:\n${text}`,
  welcome_message: (text) =>
    `Write a 3-5 sentence Slack/team welcome message for a new hire. Warm but concise — name a fun fact placeholder and a first-week ask. Reply with the message only.\n\nContext:\n${text}`,
  exit_interview: (text) =>
    `Write 6 thoughtful exit-interview questions to learn what really drove a departure. Mix experience, manager, growth, and 'what would have made you stay'. Reply as a markdown numbered list.\n\n${text}`,
  checkin_questions: (text) =>
    `Write 5 short team check-in questions that fit the context. Mix emotional, work-progress, and learning angles. Reply as a markdown numbered list, no preamble.\n\n${text}`,
  lunch_and_learn: (text) =>
    `Plan a 45-minute lunch-and-learn session on the topic. Markdown sections: **Title**, **Audience**, **Outline** (5 bullets with timing), **Required prep**, **Discussion question**.\n\n${text}`,
  coffee_chat: (text) =>
    `Suggest 6 light coffee-chat conversation starters with the person/topic in mind. Friendly, curious, avoid yes/no questions. Reply as a markdown numbered list.\n\n${text}`,
  personal_mission: (text) =>
    `Write a single sentence personal mission statement based on the context (under 25 words). Reply with just the sentence.\n\n${text}`,
  book_summary_3: (text) =>
    `Summarize the book in three sections (markdown bold labels): **Core idea** (1 sentence), **3 key takeaways** (bullets), **Who should read it** (1 sentence).\n\n${text}`,
  weekly_review: (text) =>
    `Generate 6 personal weekly-review prompts. Mix accomplishments, energy, learning, relationships, and next-week priorities. Reply as a markdown numbered list.\n\n${text}`,
  monthly_review: (text) =>
    `Write a monthly-review template tailored to the context. Markdown sections: **Wins**, **Lessons**, **Themes**, **Health & energy**, **Habits**, **Next-month focus**, each with 1-3 prompts.\n\n${text}`,
  goal_tree: (text) =>
    `Build a goal tree for the top-level goal below. Reply as a nested markdown bullet list: the top goal, 3 sub-goals beneath, 2-3 concrete actions per sub-goal.\n\n${text}`,
  habits_list: (text) =>
    `Suggest 5 habits that would advance the goal/area below. For each, give the habit, a trigger ('After I X'), and a 2-minute starter version. Reply as markdown bullets formatted '- **Habit** · Trigger: … · Start small: …'.\n\n${text}`,
  reading_list: (text) =>
    `Recommend 5 books closely matched to the topic. For each, give title — author — one short reason. Reply as markdown bullets.\n\nTopic:\n${text}`,
  mantra: (text) =>
    `Write 3 short personal mantras (3-7 words each) aligned with the context. Avoid clichés. Reply as a markdown bullet list, no preamble.\n\n${text}`,
  vision_statement: (text) =>
    `Draft an organizational vision statement (1-2 sentences, future tense, ambitious yet concrete) from the context. Reply with just the statement.\n\n${text}`,
  quarterly_okrs: (text) =>
    `Write quarterly OKRs for the area. One inspirational Objective, then 3 measurable Key Results — each with a baseline, target, and primary metric. Reply as markdown.\n\nArea:\n${text}`,
  negotiation_script: (text) =>
    `Draft a negotiation script for the situation below. Markdown sections: **Opening**, **Anchor**, **If they push back**, **Trade space**, **Walk-away**, each 1-2 lines.\n\nContext:\n${text}`,
  performance_review: (text) =>
    `Write a balanced performance review comment from the context. Markdown sections: **Strengths** (2-3 bullets with examples), **Growth areas** (2-3 bullets), **Goals for next cycle**.\n\n${text}`,
  perf_feedback: (text) =>
    `Write peer feedback using the SBI (Situation–Behavior–Impact) model. 2 bullets: one positive SBI and one constructive SBI. Reply as markdown.\n\nContext:\n${text}`,
  skip_level: (text) =>
    `Write 6 thoughtful skip-level meeting questions to learn what's actually happening on the team. Mix culture, blockers, manager effectiveness, growth. Reply as a markdown numbered list.\n\n${text}`,
  feedback_360: (text) =>
    `Build a 360-feedback survey skeleton. Markdown sections: **Peer questions** (3), **Manager questions** (3), **Direct-report questions** (3), each open-ended.\n\nContext:\n${text}`,
  career_ladder: (text) =>
    `Sketch a 4-step career ladder (Junior → Mid → Senior → Staff) for the role described. For each level give 2-3 bullets: scope, impact, behaviors expected.\n\n${text}`,
  comp_band: (text) =>
    `Explain a compensation band range neutrally. Markdown sections: **Why the floor**, **Why the ceiling**, **What moves someone up the band**, **What's negotiable**.\n\nContext:\n${text}`,
  pip_plan: (text) =>
    `Draft a 30/60/90-day Performance Improvement Plan structure. Markdown sections: **Concerns**, **Specific objectives** (3 SMART), **Support & check-ins**, **Success criteria**, **Consequences**. Keep tone clear, not punitive.\n\nContext:\n${text}`,
  reorg_memo: (text) =>
    `Draft a calm internal reorganization announcement memo. 4-5 short paragraphs: what's changing, why, what stays the same, who to talk to, immediate next steps.\n\nContext:\n${text}`,
  hiring_rubric: (text) =>
    `Create a structured hiring rubric for the role. Reply as a markdown table with columns | Competency | Below bar (1) | Meets bar (3) | Exceeds (5) | Sample signals |, 4-6 rows.\n\nRole:\n${text}`,
  reference_check: (text) =>
    `Write 6 reference-check questions for the candidate / role. Focus on behavior, working style, and tactful weakness-probing. Reply as a markdown numbered list.\n\n${text}`,
  promotion_case: (text) =>
    `Build a promotion case for the person. Markdown sections: **Scope today** vs **Scope at next level** (side-by-side bullets), **Concrete impact** (3 bullets with metrics), **Why now**, **Endorsements**.\n\n${text}`,
  short_story: (text) =>
    `Write a 200-word short story inspired by the prompt below. One scene, vivid sensory detail, a small twist at the end. Reply with the story as prose paragraphs only.\n\nPrompt:\n${text}`,
  character_bio: (text) =>
    `Create a character bio for a novel or game. Markdown sections: **Name**, **Role**, **Background** (2-3 sentences), **Motivation**, **Flaw**, **Quirk**, **One signature line of dialogue**.\n\nContext:\n${text}`,
  worldbuilding: (text) =>
    `Sketch a fictional world for the setting below. Markdown sections: **Setting (one paragraph)**, **Magic / tech rules**, **Power structure**, **Daily life**, **Active conflict**, each 1-3 bullets.\n\n${text}`,
  dialogue_scene: (text) =>
    `Write a tense 2-person dialogue scene (10-14 lines) based on the prompt. Use 'Speaker:' style. End on an unresolved beat. Reply with the dialogue only.\n\nPrompt:\n${text}`,
  lesson_plan: (text) =>
    `Build a 45-minute lesson plan on the topic. Markdown sections: **Learning objective**, **Hook (5 min)**, **Direct instruction (10 min)**, **Activity (20 min)**, **Discussion (5 min)**, **Exit ticket (5 min)**.\n\nTopic:\n${text}`,
  study_plan: (text) =>
    `Design a 1-week study plan for the topic. Reply as a markdown table with columns | Day | Focus | Tasks | Self-check |, 7 rows (Mon-Sun).\n\nTopic:\n${text}`,
  architecture_review: (text) =>
    `Act as a senior architect reviewing the proposal below. Markdown sections: **What I like**, **What worries me**, **Open questions**, **Suggested next step**. Be specific.\n\n${text}`,
  docstring: (text) =>
    `Write a clean docstring for the function described. Choose JSDoc or Google-style based on the signature. Include param types, return, throws, and one short example.\n\n${text}`,
  sample_data: (text) =>
    `Generate 5 realistic sample records (JSON array) matching the entity described. No personally-identifying real names; use plausible fake values. Reply with a fenced \`\`\`json block only.\n\nEntity:\n${text}`,
  json_schema: (text) =>
    `Infer a JSON Schema (draft-07) from the example JSON below. Pick types, required fields, and concise descriptions. Reply with a fenced \`\`\`json block only.\n\nExample:\n${text}`,
  sql_optimize: (text) =>
    `Review the SQL query below. Suggest 3 specific optimizations (indexes, rewrites, plan hints). Reply as markdown with: a fenced \`\`\`sql block of the rewritten query first, then '**Reasoning**' bullets.\n\nQuery:\n${text}`,
  code_comment: (text) =>
    `Add precise, value-add inline comments to the code below. Avoid restating what code does line-by-line; only annotate non-obvious behavior, invariants, or gotchas. Reply with the commented code in a fenced code block.\n\n${text}`,
  investor_update: (text) =>
    `Draft a concise monthly investor update email. Markdown sections with bold labels: **TL;DR**, **Wins**, **Losses / risks**, **Key metrics** (3 bullets with this-month vs last-month), **Asks**.\n\nContext:\n${text}`,
  board_update: (text) =>
    `Write a board-meeting update memo. Markdown sections: **Highlights since last meeting**, **Financial summary**, **Top 3 strategic priorities**, **Decisions requested**, **Concerns**.\n\nContext:\n${text}`,
  pitch_deck: (text) =>
    `Outline a 10-slide investor pitch deck. Reply as a markdown numbered list (1-10) where each line is 'Slide N — Title: 1-sentence content'.\n\nContext:\n${text}`,
  gtm_plan: (text) =>
    `Sketch a go-to-market plan. Markdown sections: **Target segment**, **Positioning** (one sentence), **Channels** (3 bullets), **Launch sequence** (T-30, T-7, T-0, T+30), **Success metrics**.\n\n${text}`,
  pricing_strategy: (text) =>
    `Propose a 3-tier pricing strategy. Markdown with: a comparison table | Tier | Price | Audience | Key value |, then 2 sentences explaining trade-offs and one suggested launch promotion.\n\n${text}`,
  financial_narrative: (text) =>
    `Turn the financial numbers below into a 2-paragraph narrative an investor would read. Cover trend, drivers, and what to watch. Reply as prose.\n\nNumbers:\n${text}`,
  branding_attributes: (text) =>
    `Define the brand. Markdown sections: **5 attributes we want to be known for** (single words), **5 attributes we are NOT**, **One-line elevator personality**.\n\n${text}`,
  tone_voice: (text) =>
    `Write a brand tone-of-voice guide. Markdown sections: **Personality** (3 adjectives), **Sounds like / not like** (paired bullets), **Do / Don't** (3 each), **Sample line** rewritten in our voice.\n\n${text}`,
  editorial_calendar: (text) =>
    `Build a quarterly editorial calendar. Reply as a markdown table with columns | Week | Blog | Newsletter | Social | Owner |, 12 rows (Q ~ 12 weeks).\n\nContext:\n${text}`,
  cs_playbook: (text) =>
    `Draft a customer-success playbook. Markdown sections: **Onboarding milestones** (4 bullets), **Health-score signals** (3), **Risk plays**, **Expansion plays**, **Save plays** — each as bullets.\n\n${text}`,
  discovery_deck: (text) =>
    `Outline a discovery readout deck. Reply as 8 slides in markdown, each line 'Slide N — Title: one sentence of content'. Slides: cover, goal, method, who we talked to, themes, quotes, implications, next steps.\n\n${text}`,
  github_issue: (text) =>
    `Draft a GitHub bug report issue body. Markdown sections: **Summary**, **Steps to reproduce** (numbered), **Expected**, **Actual**, **Environment** (OS / browser / version), **Logs / screenshots**.\n\nContext:\n${text}`,
  github_pr: (text) =>
    `Write a GitHub PR description for the change. Markdown sections: **Summary** (2-3 sentences), **Why**, **Changes** (3-5 bullets), **Test plan** (markdown checkboxes), **Screenshots / notes**.\n\nContext:\n${text}`,
  apology_letter: (text) =>
    `Draft a professional apology email. 3 short paragraphs: take ownership, explain what happened (no excuses), commit to a specific remedy with a date. Subject line first, blank, then body.\n\nContext:\n${text}`,
  thank_you_note: (text) =>
    `Write a personal thank-you note (3-4 sentences) that names a specific thing the recipient did and the difference it made. Reply with the note body only.\n\n${text}`,
  reddit_post: (text) =>
    `Write a Reddit-style post for an enthusiast subreddit. Conversational, slightly self-deprecating, ends with a question to invite replies. Title line first (under 90 chars), then a blank line, then the body.\n\nTopic:\n${text}`,
  hn_post: (text) =>
    `Write a 'Show HN:' style Hacker News post (under 1500 chars). Lead with the build, the why, the tech stack, links placeholder, and a request for feedback. Reply with the post body only.\n\n${text}`,
  screenplay_scene: (text) =>
    `Write a short screenplay scene (12-20 lines) in standard format: SLUGLINE (INT./EXT. PLACE - TIME), action paragraphs, character name CENTERED with dialogue underneath. Reply with just the scene.\n\nPrompt:\n${text}`,
  story_arc: (text) =>
    `Sketch a 3-act story arc for the premise. Markdown bold labels: **Setup**, **Rising action**, **Midpoint twist**, **Crisis**, **Climax**, **Resolution**, each 1-2 sentences.\n\nPremise:\n${text}`,
  sonnet: (text) =>
    `Write a Shakespearean sonnet (14 lines, ABAB CDCD EFEF GG, iambic pentameter) inspired by the topic. Reply with just the poem, one line per line.\n\n${text}`,
  free_verse: (text) =>
    `Write a 6-10 line free-verse poem inspired by the topic. Use concrete imagery, no rhyme. Reply with just the poem.\n\n${text}`,
  idiom_translate: (text) =>
    `Translate the idiom or culturally-loaded phrase below into natural-sounding English (or vice versa). Do NOT translate literally — preserve meaning, mood, register. Reply on one line.\n\n${text}`,
  comedian_bit: (text) =>
    `Write a 60-second stand-up comedy bit on the topic. Casual, observational, three callbacks. Reply as plain prose, no stage directions.\n\nTopic:\n${text}`,
  yelp_review: (text) =>
    `Write a Yelp-style restaurant/shop review (3 paragraphs) — opening hook, specific detail (food/service/atmosphere), final verdict with a star rating at the end. Reply with the review only.\n\nContext:\n${text}`,
  recipe: (text) =>
    `Write a simple recipe based on the ingredients/intent below. Markdown sections: **Yields**, **Time**, **Ingredients** (bullets with quantities), **Steps** (numbered, short).\n\nContext:\n${text}`,
  handover_doc: (text) =>
    `Write a job handover document. Markdown sections: **Role overview**, **Active projects** (3-5 bullets each with status & owner contact), **Routine tasks** (calendar/weekly), **Key people**, **Open issues**, **Where things live (links placeholder)**.\n\n${text}`,
  runbook: (text) =>
    `Draft an operations runbook for the situation. Markdown sections: **Trigger / symptom**, **Quick check** (3 bullets), **Mitigation steps** (numbered), **Verification**, **Rollback**, **Who to page**.\n\n${text}`,
  troubleshooting: (text) =>
    `Build a troubleshooting flow. Reply as markdown: a top symptom statement, then a nested bullet tree of '- If X → check Y' with 2 levels of depth.\n\nSymptom:\n${text}`,
  partnership_pitch: (text) =>
    `Draft a partnership outreach email. 4-5 short paragraphs: warm intro, why their company specifically, 2-3 mutual benefits, a low-friction next step. Subject line first, blank, then body.\n\nContext:\n${text}`,
  demo_day_pitch: (text) =>
    `Write a 60-second demo-day pitch (4-5 sentences). Order: hook, problem, what we built, traction stat, ask. Reply as plain prose.\n\nContext:\n${text}`,
  angel_update: (text) =>
    `Write a casual angel-investor update (4-6 sentences). Friendlier than the formal investor update — share a personal note, one win, one challenge, one ask. Reply as plain prose.\n\nContext:\n${text}`,
  buying_guide: (text) =>
    `Write a category buying guide. Markdown sections: **What this product is**, **Who should buy it**, **What to look for** (5 bullets), **Common mistakes**, **Decision checklist** (- [ ] …).\n\nCategory:\n${text}`,
  comparison_vs: (text) =>
    `Compare our offering vs a named alternative (or generic alternative if unspecified). Markdown table with columns | Need | Our solution | Alternative | Winner |. 5 rows. Be fair, not slanted.\n\nContext:\n${text}`,
  one_pager: (text) =>
    `Write a product one-pager. Markdown sections: **Headline**, **Problem** (2 sentences), **Solution** (2 sentences), **Key features** (3 bullets), **Social proof**, **CTA** (3 words). Keep total under 200 words.\n\nContext:\n${text}`,
  meeting_recap: (text) =>
    `Draft a meeting recap email. 3-4 short paragraphs: thanks for the time, key decisions made, action items with owners and dates, what we'll send next. Subject line first.\n\nContext:\n${text}`,
  knowledge_transfer: (text) =>
    `Outline a knowledge-transfer session (60 min). Markdown sections: **Audience**, **Pre-reads**, **Live walkthrough order** (5 bullets with timing), **Hands-on exercise**, **Q&A topics expected**, **Resources to leave behind**.\n\nTopic:\n${text}`,
  eli_expert: (text) =>
    `Explain the concept below to an expert in the field. Skip basics. Use precise terminology, cite the nuance non-experts miss, and call out 1-2 active debates. 3-5 dense paragraphs.\n\n${text}`,
  press_statement: (text) =>
    `Draft a brief, calm public statement (3 short paragraphs) responding to the situation. Acknowledge what happened, share what we're doing about it, point to next update. Avoid jargon and corporate hedging.\n\nSituation:\n${text}`,
  investor_faq: (text) =>
    `Generate 6 likely investor FAQ questions and concise answers about the venture below. Mix market, business model, team, traction, defensibility. Reply as markdown '**Q:**' / '**A:**' pairs.\n\n${text}`,
  linkedin_newsletter: (text) =>
    `Write LinkedIn newsletter issue #1 (250-350 words) for the topic. Hook intro, two named subsections with H2, one personal anecdote, end with a question. Reply as markdown.\n\n${text}`,
  thought_leader: (text) =>
    `Write a 'thought leadership' social post (120-180 words). Take a clear, slightly contrarian stance. Single insight, two short supporting lines, one provocative close. Reply as plain prose.\n\n${text}`,
  podcast_notes: (text) =>
    `Draft podcast show notes for the episode. Markdown sections: **Episode title**, **Guest bio** (1 sentence), **Topics covered** (5 bullets), **Memorable quote**, **Resources mentioned**, **Where to listen** (placeholder links).\n\n${text}`,
  video_script: (text) =>
    `Write a 3-minute video script. Markdown sections: **Hook (0-10s)**, **Setup (10-30s)**, **Main content (30-150s)** with 3 beats, **Recap & CTA (150-180s)**. Write actual spoken lines, not just topics.\n\n${text}`,
  infographic_labels: (text) =>
    `Suggest 10 short labels (2-4 words each) for an infographic on the topic. Reply as a markdown numbered list, no preamble.\n\n${text}`,
  toast_speech: (text) =>
    `Write a 30-60 second toast for a work celebration (회식). Friendly, inclusive, names one specific shared moment, ends with a clear toast line ('To …!'). Reply as plain prose.\n\nContext:\n${text}`,
  wedding_toast: (text) =>
    `Write a 90-second wedding toast as a friend of one of the couple. Warm, one funny anecdote, one heartfelt observation about the couple, a clear toast line at the end. Reply as plain prose.\n\nContext:\n${text}`,
  birthday_message: (text) =>
    `Write a thoughtful birthday message (3-4 sentences) personalized to the person below. Specific, warm, no clichés. Reply with the message only.\n\n${text}`,
  condolence: (text) =>
    `Write a brief, warm condolence note (3 sentences). Acknowledge the loss, share one specific memory or quality, offer concrete support. Avoid platitudes. Reply with the note only.\n\nContext:\n${text}`,
  referral_request: (text) =>
    `Draft a polite referral-request message. 4 short sentences: appreciate the relationship, name what you're looking for, suggest one specific person if any, offer to make it easy. Reply with the message only.\n\nContext:\n${text}`,
  linkedin_profile: (text) =>
    `Write a 'About' section for a LinkedIn profile (~150 words). First person, story arc (where I came from → what I do now → what I'm exploring next). Reply with the body only.\n\nContext:\n${text}`,
  substack_post: (text) =>
    `Write a Substack-style email newsletter post (500-700 words) on the topic. Personal voice, 2-3 H2 sections, ends with a single bold takeaway and a 'reply with your thoughts' invite. Markdown.\n\n${text}`,
  elevator_no_jargon: (text) =>
    `Write a 30-second elevator pitch with ZERO industry jargon, suitable for explaining to a smart 12-year-old. 3 sentences. Reply as plain prose.\n\n${text}`,
  data_table_narrative: (text) =>
    `Read the data/table below and write a 2-paragraph narrative an executive would want. Lead with the headline finding, name 2 contributing factors, name 1 thing to watch.\n\n${text}`,
  chart_caption: (text) =>
    `Suggest a chart caption for the data below. Reply as markdown with two lines: '**Headline:** …' (under 80 chars) and '**Subtitle:** …' (one sentence of context).\n\n${text}`,
  dashboard_summary: (text) =>
    `Summarize the metrics dashboard below in a single 1-2 sentence line a Slack channel would post. Mention the most movement first.\n\n${text}`,
  sql_explain: (text) =>
    `Explain the SQL query below in 3-4 sentences of plain Korean (or English if the surrounding context is English). Cover: what it returns, how it joins/filters, edge cases.\n\nQuery:\n${text}`,
  cli_help: (text) =>
    `Write a CLI help text for the command described. Format: usage line, one-line description, then '**Options**' bullet list. Keep it terse, manpage style.\n\nContext:\n${text}`,
  error_explain: (text) =>
    `An error/log is below. Reply as markdown with: '**Likely cause:**' (1 sentence), '**Quick checks:**' (3 bullets), '**Common fixes:**' (3 bullets).\n\nError:\n${text}`,
  refactor_suggest: (text) =>
    `Suggest 3 specific refactorings for the code below. For each: a name (verb phrase), why it helps, and a 2-line code-shape sketch. Reply as markdown.\n\nCode:\n${text}`,
  test_edge_cases: (text) =>
    `List 7 edge cases the implementation below must handle. Be concrete (specific inputs / states). Reply as a markdown numbered list.\n\n${text}`,
  name_suggest: (text) =>
    `Suggest 5 names for the thing described below. Mix styles: literal, metaphor, single-syllable, compound, foreign-rooted. For each, one short justification. Reply as markdown bullets formatted '- **Name** — why'.\n\n${text}`,
  explain_diagram: (text) =>
    `The diagram or ASCII below is the input. Describe in prose what it shows, in the right reading order, and what the reader should take from it. 1-2 paragraphs.\n\n${text}`,
  sequence_diagram: (text) =>
    `Produce a Mermaid \`sequenceDiagram\` code block for the interaction below. Use 3-6 participants. Wrap in a fenced \`\`\`mermaid block.\n\n${text}`,
  state_machine: (text) =>
    `Produce a Mermaid \`stateDiagram-v2\` code block for the state machine described. Include initial, terminal, and 3-5 intermediate states. Wrap in a fenced \`\`\`mermaid block.\n\n${text}`,
  ad_headlines: (text) =>
    `Write 7 ad headlines (each under 70 chars) for the offering. Vary the angle: benefit, fear-of-missing-out, curiosity, social proof, urgency, contrarian, question. Reply as a markdown numbered list.\n\n${text}`,
  og_tags: (text) =>
    `Generate Open Graph meta tags for the page. Reply as markdown showing exact HTML tags:\n\\\`\\\`\\\`html\n<meta property="og:title" content="…">\n…\n\\\`\\\`\\\`\nInclude og:title, og:description, og:image (placeholder), og:url (placeholder), og:type, twitter:card.\n\nContext:\n${text}`,
  commit_template: (text) =>
    `Design a team git commit message template. Markdown sections: **Format** (with example), **Allowed types**, **Scope rules**, **Subject rules** (length, mood), **Body rules**, **Trailer rules**, **Examples** (2 good, 1 bad).\n\nContext:\n${text}`,
  branch_name: (text) =>
    `Suggest 5 git branch name candidates following the format <type>/<short-kebab-summary>. Types: feat / fix / chore / docs / refactor. Reply as a markdown bullet list.\n\nContext:\n${text}`,
  unit_test_skeleton: (text) =>
    `Write a unit-test skeleton for the function below in the most idiomatic framework for its language. Cover happy path, one edge case, and one error case. Reply with the code in a fenced block.\n\nFunction:\n${text}`,
  readme_skeleton: (text) =>
    `Write a README.md skeleton tailored to the project. Sections: title + tagline, badges placeholder, **Why**, **Quick start** (code block), **Features**, **Configuration**, **Development**, **Contributing**, **License**.\n\nProject:\n${text}`,
  contributing_md: (text) =>
    `Write a CONTRIBUTING.md for the project. Markdown sections: **Code of conduct**, **Reporting issues**, **Suggesting features**, **Setting up dev env**, **Making a PR** (numbered steps), **Commit/branch conventions**.\n\nProject:\n${text}`,
  license_pick: (text) =>
    `Recommend one OSS license fitting the project + summarize trade-offs of 2 alternatives. Reply as markdown with bold sections: **Recommended:** name + 2 sentences why, **Alternatives:** 2 bullets each '- **Name** — one-line trade-off'.\n\nProject:\n${text}`,
  cron_explain: (text) =>
    `Explain the cron expression below in plain Korean (or English if the context is English). State minute, hour, day-of-month, month, day-of-week parts, then summarize when it fires.\n\nExpression:\n${text}`,
  regex_explain: (text) =>
    `Explain the regex below piece by piece in plain language. Reply as a markdown bullet list, one bullet per token group, then a one-line 'what it matches overall' summary.\n\nRegex:\n${text}`,
  env_var_doc: (text) =>
    `Document the environment variables suggested by the snippet below. Reply as a markdown table with columns | Variable | Required? | Default | Purpose | Where it's used |.\n\nContext:\n${text}`,
  elevator_perspectives: (text) =>
    `Write the same elevator pitch 3 ways, voiced for: **CEO**, **Engineer**, **Designer**. Each version 2-3 sentences, reflecting that persona's priorities and vocabulary. Reply as markdown with bold section headers.\n\nSubject:\n${text}`,
  twitter_bio: (text) =>
    `Write 3 Twitter/X profile bios (under 160 chars each). Vary the angle: serious, playful, niche-expert. Reply as a markdown numbered list.\n\nContext:\n${text}`,
  instagram_caption: (text) =>
    `Write an Instagram caption (under 220 chars) for the post described. Add 5-7 relevant hashtags on a separate line. Reply as plain text.\n\nContext:\n${text}`,
  tiktok_hook: (text) =>
    `Write 5 TikTok-style opening hooks (each under 12 words) for the topic. Curiosity-driven, conversational. Reply as a markdown numbered list.\n\n${text}`,
  youtube_title: (text) =>
    `Suggest 5 YouTube video titles for the topic. Each under 70 chars, optimized for click-through but honest. Reply as a markdown numbered list.\n\n${text}`,
  youtube_description: (text) =>
    `Write a YouTube video description from the context. Markdown sections: **About this video** (2-3 sentences), **Chapters** (5 timestamps like 0:00, 1:30 …), **Links** (placeholder), **Subscribe / follow** (2 lines).\n\n${text}`,
  app_store_desc: (text) =>
    `Write App Store / Play Store copy for the app. Markdown sections: **Subtitle** (under 30 chars), **Promotional text** (under 170 chars), **Description** (4 short paragraphs).\n\n${text}`,
  notification_copy: (text) =>
    `Write 3 push-notification variants for the event below. Each under 90 chars, friendly, non-spammy. Reply as a markdown numbered list.\n\n${text}`,
  email_subject_ab: (text) =>
    `Generate 3 A/B email subject pairs (each under 60 chars). Vary curiosity vs. benefit, question vs. statement. Reply as markdown: '**Test 1** A: … / B: …' etc.\n\nEmail topic:\n${text}`,
  empty_state_copy: (text) =>
    `Write empty-state copy for the screen described. Markdown sections: **Title** (under 8 words, encouraging), **Body** (1-2 sentences explaining what goes here), **CTA** (3-word button).\n\nScreen:\n${text}`,
  message_404: (text) =>
    `Write a friendly 404 page message for the product. Markdown sections: **Title** (witty, on-brand), **Body** (1-2 lines reassuring), **CTA** (2 options: 'Back home', 'Search').\n\nProduct:\n${text}`,
  maintenance_notice: (text) =>
    `Write a maintenance notice (3 sentences). State that we're working on improvements, give an honest ETA window, thank for patience. Reply with the notice only.\n\nContext:\n${text}`,
  system_status_blurb: (text) =>
    `Write a status-page blurb for the service described — one line of plain explanation suitable for non-engineers. Avoid jargon. Reply with the single line only.\n\n${text}`,
  holiday_greeting: (text) =>
    `Write a brief B2B holiday greeting (3-4 sentences). Warm but professional, mention shared progress, look ahead to next year, no specific religion. Reply with the message only.\n\nContext:\n${text}`,
  jira_ticket: (text) =>
    `Draft a Jira ticket. Markdown sections: **Summary** (under 80 chars), **Description**, **Acceptance criteria** (- [ ] …, 3-5 items), **Notes**, **Labels** (comma-sep).\n\nContext:\n${text}`,
  linear_ticket: (text) =>
    `Draft a concise Linear issue. Markdown with **Title** (under 70 chars), one-paragraph description, then '## Acceptance criteria' with 3 checkbox bullets, then '## Notes' (optional).\n\nContext:\n${text}`,
  weekly_status: (text) =>
    `Write a team weekly status email. Markdown sections with bold labels: **Done this week**, **In progress**, **Up next**, **Blockers**, each 2-4 bullets. Single paragraph closer.\n\nContext:\n${text}`,
  exec_1pager: (text) =>
    `Write an executive 1-pager for a decision request. Markdown sections: **Decision needed**, **Background** (2 sentences), **Options** (3 bullets with trade-offs), **Recommendation**, **What we need from you** (one ask).\n\n${text}`,
  risk_rag: (text) =>
    `Evaluate the risks below using a RAG (Red/Amber/Green) rating. Reply as a markdown table with columns | Risk | Rating | Why | Owner | Next action |, 4-6 rows.\n\n${text}`,
  budget_narrative: (text) =>
    `Write a 2-paragraph budget request narrative. Cover: what we're asking for, what it unlocks, what happens without it, and what alternative we considered.\n\nContext:\n${text}`,
  faq_localize: (text) =>
    `Localize the FAQ below into Korean, English, and Japanese. Reply as markdown with three top-level H2 sections '## English', '## 한국어', '## 日本語' each containing the same Q&A pairs translated naturally.\n\nFAQ source:\n${text}`,
  security_runbook: (text) =>
    `Draft a security-incident response runbook. Markdown sections: **Detect** (signals), **Triage** (3 first questions), **Contain** (steps), **Eradicate**, **Recover**, **Communicate** (internal/external), **Postmortem trigger**.\n\nContext:\n${text}`,
  incident_customer_comms: (text) =>
    `Draft a customer-facing incident communication. 4 short paragraphs: acknowledge the issue, explain impact in plain language, share what we're doing now, share when we'll update next. Subject line first.\n\nContext:\n${text}`,
  tweet_rewrite: (text) =>
    `Rewrite the tweet 3 ways: **Punchier** (shorter), **Friendlier** (warmer), **Sharper** (stronger claim). Each under 280 chars. Reply as markdown with bold labels.\n\nOriginal tweet:\n${text}`,
  linkedin_comment: (text) =>
    `Write a 2-3 sentence LinkedIn comment in response to the post below. Add to the discussion (a specific take or data point), avoid empty agreement. Reply with the comment only.\n\nPost:\n${text}`,
  yc_application: (text) =>
    `Draft answers to 5 key YC application questions about the startup: 'What does your company do?', 'What's new about what you make?', 'Why now?', 'Who are your competitors?', 'How will you make money?'. Markdown bold Q + 2-3 sentence A.\n\nContext:\n${text}`,
  cv_bullet: (text) =>
    `Write a CV bullet in the X-Y-Z formula ('Accomplished X, as measured by Y, by doing Z'). Active verbs, quantified impact. Reply with 3 alternate versions as a markdown bullet list.\n\nContext:\n${text}`,
  lightning_talk: (text) =>
    `Outline a 5-minute lightning talk. Markdown sections: **Title**, **Hook (30s)**, **Setup (1m)**, **Big idea (2m)**, **Demo or example (1m)**, **Takeaway (30s)** — each with 1-2 lines of actual content, not just labels.\n\nTopic:\n${text}`,
  conference_cfp: (text) =>
    `Draft a conference CFP submission. Markdown sections: **Title**, **Abstract (under 150 words)**, **Outline** (5 bullets), **Audience takeaways** (3 bullets), **Speaker bio** (2 sentences).\n\nTopic:\n${text}`,
  talk_abstract: (text) =>
    `Write a conference talk abstract (150-200 words). Hook intro, problem framing, what you'll cover (3 beats), audience takeaway. Reply as prose paragraphs.\n\nTopic:\n${text}`,
  intro_bio_speaker: (text) =>
    `Write a 60-90 second speaker introduction the MC will read aloud. Warm but professional, names 2 credentials and one human detail, ends with a clean cue. Reply as plain prose.\n\nSpeaker:\n${text}`,
  workshop_plan: (text) =>
    `Plan a 2-hour interactive workshop on the topic. Markdown sections: **Goal**, **Materials**, **Schedule (with timings)**, **Activity 1**, **Activity 2**, **Debrief questions** (3), **Take-home**.\n\nTopic:\n${text}`,
  curriculum_outline: (text) =>
    `Design an 8-week curriculum on the topic. Reply as a markdown table | Week | Title | Topics covered | Assignment |, one row per week.\n\nTopic:\n${text}`,
  test_plan: (text) =>
    `Draft a QA test plan. Markdown sections: **Scope**, **Test types** (functional / integration / regression / load / security — pick relevant), **Environments**, **Acceptance criteria**, **Risk areas**, **Sign-off list**.\n\nFeature:\n${text}`,
  bug_priority: (text) =>
    `Rank the bug below by priority and severity. Reply as markdown with bold labels: **Priority** (P0-P3 + 1 sentence), **Severity** (S0-S3 + 1 sentence), **Suggested SLA**, **Owner type**.\n\nBug:\n${text}`,
  eli5_medical: (text) =>
    `Explain the medical concept below to a patient with no medical background. Avoid jargon, no scary language, end with a practical 'what does this mean for me' line. 3-4 sentences.\n\n${text}`,
  eli5_legal: (text) =>
    `Translate the legal clause below into plain language a non-lawyer would understand. Cover what it means, who it applies to, and what action it implies. 3-5 sentences.\n\n${text}`,
  eli5_financial: (text) =>
    `Explain the financial concept below to someone who isn't a finance person. Use one everyday analogy and one concrete number example. 3-4 sentences.\n\n${text}`,
  family_update: (text) =>
    `Write a warm family update message (4-6 sentences) covering recent news, how you're feeling, one specific shared memory you want to mention, and a question to invite a reply.\n\nContext:\n${text}`,
  old_friend_msg: (text) =>
    `Write a casual 'reaching out after a long time' message to an old friend (3-4 sentences). Acknowledge the gap warmly, share one update, suggest a low-pressure way to reconnect.\n\nContext:\n${text}`,
  ad_mock_banner: (text) =>
    `Write banner ad copy for the offering. Markdown sections: **Headline** (under 8 words), **Subhead** (under 14 words), **CTA** (3 words). Bonus: 2 alternative headline variants.\n\n${text}`,
  google_ad: (text) =>
    `Generate Google Ads copy. Markdown sections: **Headlines** (5, each under 30 chars), **Descriptions** (2, each under 90 chars), **Final URL placeholder**, **Display path**.\n\nContext:\n${text}`,
  facebook_ad: (text) =>
    `Write a Facebook/Meta ad. Markdown sections: **Primary text** (under 125 chars), **Headline** (under 40 chars), **Description** (under 30 chars), **CTA** (pick: Learn More / Sign Up / Get Offer).\n\n${text}`,
  email_sequence_5: (text) =>
    `Outline a 5-email drip sequence. For each email give: **Day** (e.g. Day 0, Day 3 …), **Subject**, **Goal**, **Body in 2 sentences**. Reply as markdown.\n\nGoal of the sequence:\n${text}`,
  welcome_flow: (text) =>
    `Design a 3-step user welcome flow (in-product). For each step: screen title, one-line copy, primary CTA, what success looks like. Reply as markdown sections '**Step 1**', '**Step 2**', '**Step 3**'.\n\nContext:\n${text}`,
  upsell_msg: (text) =>
    `Write an in-app upsell message (3 sentences). Surface a moment the user just hit a limit, name the plan benefit, soft CTA. Reply with the message + a 3-word CTA on a separate line.\n\nContext:\n${text}`,
  cancel_recovery: (text) =>
    `Draft a cancellation-page 'last-chance' offer message (3-4 sentences). Acknowledge the decision, share one strong reason to stay, offer a concrete incentive (e.g. 50% off 3 months), and a clean exit. Reply with the message only.\n\nContext:\n${text}`,
  winback: (text) =>
    `Write a winback email to a churned customer. 4-5 sentences. Acknowledge the gap, share what's new since they left, low-friction offer, polite close. Subject line first.\n\nContext:\n${text}`,
  nps_followup: (text) =>
    `Write 3 NPS follow-up messages: one for **promoters (9-10)**, one for **passives (7-8)**, one for **detractors (0-6)**. Each 2-3 sentences. Reply as markdown.\n\nContext:\n${text}`,
  csat_script: (text) =>
    `Generate 5 CSAT survey questions. Include 1 likert (1-5), 2 multi-choice, 1 ranking, 1 open. Reply as markdown numbered list with the type label in parens.\n\nContext:\n${text}`,
  handoff_summary: (text) =>
    `Write a shift/role handoff summary (markdown). Sections: **What's active**, **Blockers**, **Customer notes**, **Watch list**, **Anything I changed in the last hour**. Each 2-4 bullets.\n\n${text}`,
  ooo_message: (text) =>
    `Write a clear out-of-office auto-reply (3 short paragraphs). Date range, who to contact for urgent issues, when you'll respond. Friendly but brief. Reply with the message only.\n\nContext:\n${text}`,
  calendar_invite_note: (text) =>
    `Write a calendar invite description. Markdown: one-line purpose, bullet agenda (3-5 items with timing), pre-read links placeholder, video link placeholder.\n\nContext:\n${text}`,
  job_listing: (text) =>
    `Write a job listing for LinkedIn-style boards. Markdown sections: **About the role** (3 sentences), **What you'll do** (4-5 bullets), **You bring** (4 bullets), **Bonus** (2 bullets), **Compensation & perks** (placeholder), **How to apply** (one line).\n\n${text}`,
  job_rejection_no_fit: (text) =>
    `Draft a polite candidate rejection email focused on culture-fit (no specifics that could be litigious). 3 sentences. Subject line first, then body. Warm, gracious, no false hope.\n\nContext:\n${text}`,
  internship_jd: (text) =>
    `Write an internship job description. Markdown sections: **About the team**, **What you'll learn** (4 bullets), **Day-to-day** (3 bullets), **You're a fit if** (3 bullets), **Logistics** (duration, location, hours, stipend placeholder).\n\n${text}`,
  relocation_package: (text) =>
    `Outline a relocation package. Markdown sections: **Eligibility**, **What's covered** (5 bullets), **What's not covered**, **Timeline**, **Clawback terms**, **Tax notes**.\n\nContext:\n${text}`,
  sabbatical_pitch: (text) =>
    `Draft a sabbatical request email to a manager. 4-5 short paragraphs: state the ask + duration, why now, what you'll cover before leaving, return-to-work plan, gratitude. Subject line first.\n\nContext:\n${text}`,
  raise_request: (text) =>
    `Draft a calm, data-backed compensation review request email. 3 short paragraphs: name the ask + reference number, summarize impact, share market data placeholder, request a meeting. Subject first.\n\nContext:\n${text}`,
  promotion_self_pitch: (text) =>
    `Write a 1-page self-advocacy memo for promotion. Markdown sections: **Why now**, **What I'm doing at the next level today** (3 bullets), **Quantified impact** (3 bullets), **Endorsements** (placeholder), **Open growth areas I'm working on**.\n\nContext:\n${text}`,
  transfer_request: (text) =>
    `Draft an internal team-transfer request. 3 paragraphs: current team contribution, what draws you to the target team, transition plan that doesn't burn bridges. Subject first.\n\nContext:\n${text}`,
  remote_policy: (text) =>
    `Write a remote-work policy. Markdown sections: **Eligibility**, **Time zones & overlap hours**, **Equipment & home office stipend**, **Communication norms**, **Performance expectations**, **Travel for off-sites**.\n\nContext:\n${text}`,
  handbook_page: (text) =>
    `Write a single employee-handbook page on the topic. Markdown sections: **What it is**, **Why it matters**, **How it works in practice**, **What to do if…**, **Who owns this policy**.\n\nTopic:\n${text}`,
  code_of_conduct: (text) =>
    `Write an OSS project code of conduct (markdown). Sections: **Our pledge**, **Expected behavior** (3 bullets), **Unacceptable behavior** (4 bullets), **Reporting**, **Enforcement** (3-step). Keep firm but warm.\n\nContext:\n${text}`,
  community_rules: (text) =>
    `Write 5 short, clear community rules for the space. Each rule: a one-line directive + a one-sentence explanation. Reply as a markdown numbered list.\n\nContext:\n${text}`,
  diversity_statement: (text) =>
    `Write a brief diversity, equity, and inclusion statement (2 paragraphs). Avoid platitudes — name concrete commitments and measurable goals. Reply as plain prose.\n\nContext:\n${text}`,
  social_bio: (text) =>
    `Write a short cross-social-platform bio (under 150 chars). Curious, specific, one concrete signal of credibility. Reply with just the bio.\n\n${text}`,
  influencer_pitch: (text) =>
    `Draft a brief influencer outreach email. 4-5 sentences: personalize one detail, propose the collab in one line, name the deliverables and the compensation structure (placeholder), invite a quick reply. Subject first.\n\nContext:\n${text}`,
  affiliate_pitch: (text) =>
    `Write an affiliate-program pitch email to a creator. 4-5 sentences: name the audience fit, share commission rate placeholder, link an example creator placeholder, low-friction CTA. Subject first.\n\nContext:\n${text}`,
  landing_tour: (text) =>
    `Outline a landing page's section order. Markdown numbered list. Each item: '**Section** — one-line purpose'. Suggested sections: hero, social proof, problem, solution, features (3), pricing, FAQ, CTA, footer.\n\nProduct:\n${text}`,
  security_policy: (text) =>
    `Write a brief security policy section appropriate for a B2B SaaS site. Markdown sections: **Data handling**, **Access control**, **Encryption**, **Backups & retention**, **Vulnerability disclosure**, **Compliance** — each 1-2 short bullets.\n\nContext:\n${text}`,
  incident_tweet: (text) =>
    `Write a calm, professional incident update tweet (under 280 chars). State what's affected, current state, ETA placeholder, where to follow status. No emojis.\n\nContext:\n${text}`,
  onboarding_tour: (text) =>
    `Outline 5 in-app onboarding coach-marks. For each: **Step N — Anchor (UI element)** then a one-sentence coach-mark copy + a one-word CTA. Reply as markdown.\n\nProduct:\n${text}`,
  ff_rollout: (text) =>
    `Plan a feature-flag rollout. Markdown sections: **Flag name** (snake_case), **Target population**, **Stages** (1% / 10% / 50% / 100% with success criteria), **Kill-switch trigger**, **Cleanup deadline**.\n\nFeature:\n${text}`,
  experiment_plan: (text) =>
    `Plan an A/B experiment. Markdown sections: **Hypothesis**, **Variant A (control)**, **Variant B**, **Primary metric**, **Guardrail metrics**, **Sample size & duration**, **Stopping rules**.\n\nContext:\n${text}`,
  experiment_readout: (text) =>
    `Write an A/B experiment readout. Markdown sections: **TL;DR**, **What we tested**, **Numbers** (effect size, confidence), **Why it likely moved**, **Decision (ship / kill / re-run)**, **Open questions**.\n\nData:\n${text}`,
  metric_tree: (text) =>
    `Build a north-star metric tree. Reply as a nested markdown bullet list: the north-star metric, then 3-4 input metrics, then 2-3 sub-drivers per input.\n\nProduct:\n${text}`,
  cohort_analysis: (text) =>
    `Turn the cohort numbers into a 2-paragraph narrative. Cover: which cohort behaved differently, what's the likely driver, what to do next.\n\nNumbers:\n${text}`,
  proposal_cover: (text) =>
    `Write proposal cover-page copy. Markdown sections: **Title** (centered), **Prepared for** (placeholder), **Prepared by** (placeholder), **Date**, **Confidentiality note** (one line), **Version**.\n\nContext:\n${text}`,
  sow: (text) =>
    `Draft a Statement of Work. Markdown sections: **Scope**, **Out of scope**, **Deliverables** (numbered), **Timeline & milestones**, **Acceptance criteria**, **Pricing structure**, **Change-request process**.\n\nProject:\n${text}`,
  msa_summary: (text) =>
    `Summarize the MSA in plain language. Markdown sections: **Who's signing**, **What's being agreed**, **Term & renewal**, **Liability cap**, **IP ownership**, **Termination triggers**, **Watch-outs**.\n\nClauses:\n${text}`,
  nda_summary: (text) =>
    `Summarize the NDA in plain language. Markdown sections: **Parties**, **What's considered confidential**, **What's excluded**, **Duration**, **Permitted disclosures**, **Return / destruction**.\n\n${text}`,
  dpia: (text) =>
    `Draft a Data Protection Impact Assessment skeleton. Markdown sections: **Processing description**, **Necessity & proportionality**, **Risks to data subjects**, **Safeguards**, **Residual risk**, **Sign-off**.\n\nContext:\n${text}`,
  soc2_readiness: (text) =>
    `Generate a SOC 2 readiness checklist. Markdown grouped by trust principles: **Security**, **Availability**, **Processing integrity**, **Confidentiality**, **Privacy** — each with 3-4 checkboxes.\n\nContext:\n${text}`,
  gdpr_data_map: (text) =>
    `Sketch a GDPR data-flow map. Markdown table | Data category | Source | Storage | Processor | Lawful basis | Retention |, 4-6 rows.\n\nProduct:\n${text}`,
  dpa_clause: (text) =>
    `Summarize the DPA's key clauses for a busy reader. Markdown bullets: **Roles**, **Sub-processors**, **Security measures**, **Breach notification**, **International transfers**, **Audit rights**.\n\n${text}`,
  rate_limit_msg: (text) =>
    `Write an API rate-limit error response message (JSON). Include code, human-readable message, retry-after seconds, docs link placeholder, request id placeholder. Reply as fenced JSON.\n\nContext:\n${text}`,
  billing_failure_msg: (text) =>
    `Write a billing-failure email to a customer. 3 short paragraphs: name the issue without alarm, give 2 likely causes, offer one-click action ('Update payment') placeholder, polite close. Subject first.\n\nContext:\n${text}`,
  refund_policy: (text) =>
    `Write a clear refund policy section. Markdown with bold sections: **When refunds are eligible**, **When they aren't**, **How to request**, **Processing time**, **Disputes & escalation**. Plain language throughout.\n\nContext:\n${text}`,
  data_retention_policy: (text) =>
    `Write a data retention policy table. Markdown columns | Data type | Retention period | Reason | Deletion trigger | Owner |, 5-7 rows.\n\nContext:\n${text}`,
  cookie_banner_copy: (text) =>
    `Write copy for a cookie consent banner. Markdown sections: **Headline** (1 line), **Body** (under 240 chars), **Buttons** (Accept all / Reject all / Customize labels), **Customize panel** subtitle line.\n\nContext:\n${text}`,
  elevator_tldr: (text) =>
    `Reduce the offering to a single TL;DR sentence (under 18 words). Subject — predicate — outcome. Reply with just the sentence.\n\n${text}`,
  changelog_html: (text) =>
    `Output a release changelog as semantic HTML inside a fenced \`\`\`html block. Use <section>, <h2>, <ul>, <li>, <code>, no inline styles. Group: New, Fixed, Improved, Breaking.\n\nChanges:\n${text}`,
  sql_seed: (text) =>
    `Write a SQL seed script with 5 realistic INSERT statements for the table described. Use Postgres dialect. Wrap in a fenced \`\`\`sql block. Add a one-line comment above each row explaining its purpose.\n\nTable:\n${text}`,
  dockerfile: (text) =>
    `Write a multi-stage Dockerfile for the service described. Production-ready (non-root user, slim base, build cache). Wrap in a fenced \`\`\`dockerfile block.\n\nService:\n${text}`,
  compose_yml: (text) =>
    `Write a minimal but real docker-compose.yml for the stack described. Include named volumes, environment placeholders, depends_on, healthchecks. Wrap in a fenced \`\`\`yaml block.\n\nStack:\n${text}`,
  gh_actions: (text) =>
    `Write a GitHub Actions workflow yml that runs tests + builds on push and PRs. Use Node matrix (18, 20). Wrap in a fenced \`\`\`yaml block.\n\nProject:\n${text}`,
  k8s_deploy: (text) =>
    `Write a Kubernetes Deployment + Service yaml for the app described. 2 replicas, readiness + liveness probes, resource limits. Wrap in a fenced \`\`\`yaml block.\n\nApp:\n${text}`,
  nginx_conf: (text) =>
    `Write an nginx reverse-proxy server block for the described upstream. TLS termination assumed, gzip on, sensible buffer + timeout. Wrap in a fenced \`\`\`nginx block.\n\nContext:\n${text}`,
  oauth_flow: (text) =>
    `Explain the OAuth 2.0 Authorization Code (with PKCE) flow for the integration. Markdown sections: **Roles**, **Step-by-step** (numbered 1-7), **Token storage**, **Refresh strategy**, **Common pitfalls**. End with a Mermaid sequenceDiagram in a fenced block.\n\nIntegration:\n${text}`,
  jwt_claims: (text) =>
    `Design a JWT claims set for the system described. Reply as a markdown table | Claim | Required? | Type | Purpose | Example |. Cover standard claims (iss, sub, aud, exp, iat) plus 3-5 app-specific claims.\n\nSystem:\n${text}`,
  webhook_payload: (text) =>
    `Design a webhook payload JSON spec for the event described. Include: id, type, created_at, data (typed fields), and a signature header note. Reply with a fenced \`\`\`json sample.\n\nEvent:\n${text}`,
  data_model: (text) =>
    `Sketch a relational data model for the system. For each table, give a markdown bullet block: '**Table** — columns (with types and PK/FK)'. Add a 'Relationships' summary at the end.\n\nSystem:\n${text}`,
  api_versioning: (text) =>
    `Write an API versioning policy. Markdown sections: **Scheme** (path vs header), **Deprecation timeline**, **Backward compatibility rules**, **Breaking change examples**, **How clients are notified**.\n\nContext:\n${text}`,
  prd_section: (text) =>
    `Expand one PRD section in depth. Markdown: identify which section you're writing (Problem / Goals / Requirements / UX / Risks etc.), then write 200-300 words for it with subheadings.\n\nContext:\n${text}`,
  ux_copy_review: (text) =>
    `Review the UX copy below. For each line, return: **Verdict** (Keep / Tweak / Rewrite), **Rewrite** (only if Tweak or Rewrite), **Why**. Reply as a markdown bullet list per line.\n\nCopy:\n${text}`,
  accessibility_review: (text) =>
    `Run a quick accessibility review on the UI described. Output a markdown checklist grouped by **Keyboard**, **Screen reader**, **Color/contrast**, **Focus states**, **Form labels** — each with 2-3 actionable items.\n\nUI:\n${text}`,
  perf_budget: (text) =>
    `Propose a web performance budget. Markdown table | Metric | Target | Yellow | Red |. Cover TTFB, FCP, LCP, INP, CLS, total JS size, total CSS size, image weight. Add a 'How we measure' paragraph below.\n\nContext:\n${text}`,
  observability_plan: (text) =>
    `Outline an observability plan. Markdown sections: **Logs** (what, retention), **Metrics** (RED + USE), **Traces** (sample rate, key spans), **Alerts** (page vs ticket), **Dashboards we need**.\n\nSystem:\n${text}`,
  error_budget_slo: (text) =>
    `Define an SLO + error budget. Markdown sections: **SLI** (precise definition), **SLO target** (e.g. 99.9%), **Window** (rolling 30d), **Burn rate alerts** (fast + slow), **Error budget policy** (what we change if we burn through it).\n\nService:\n${text}`,
  disaster_recovery: (text) =>
    `Draft a disaster recovery plan. Markdown sections: **RTO**, **RPO**, **Backup strategy**, **Failover steps** (numbered), **Communication plan**, **Post-incident review**.\n\nSystem:\n${text}`,
  threat_model: (text) =>
    `Run a STRIDE threat model. Markdown table | Asset | Threat | STRIDE category | Likelihood | Impact | Mitigation |, 5-8 rows.\n\nContext:\n${text}`,
  api_deprecation: (text) =>
    `Draft an API deprecation announcement. Markdown sections: **What's being deprecated**, **Why**, **Sunset date**, **Migration path** with a code-diff example, **Support window**, **How to ask questions**.\n\nAPI:\n${text}`,
  feature_sunset: (text) =>
    `Write a customer-facing feature sunset notice. 3 short paragraphs: name the feature + last day available, why, what to use instead, who to contact. Subject first.\n\nContext:\n${text}`,
  beta_invite: (text) =>
    `Draft a beta-program invitation email. 4-5 sentences: name the program + perks + commitment, link to signup placeholder, deadline, warm close. Subject first.\n\nContext:\n${text}`,
  waitlist_email: (text) =>
    `Draft a 'you're on the waitlist' confirmation email (3 sentences). Acknowledge the signup, set expectations (when they'll hear back), share something useful to do in the meantime. Subject first.\n\nContext:\n${text}`,
  early_access_email: (text) =>
    `Draft an early-access kickoff email. 4-5 sentences: welcome, login + first steps, what's still rough, how to give feedback (link placeholder), thanks. Subject first.\n\nContext:\n${text}`,
  emails_7day: (text) =>
    `Outline a 7-day email course on the topic. For each day give: **Day N — Subject**, then a 2-sentence body summary. Reply as markdown.\n\nTopic:\n${text}`,
  lead_magnet_idea: (text) =>
    `Suggest 5 lead-magnet ideas for the audience. For each: title, format (PDF / template / Notion doc / video / mini-course), 1-line value promise. Reply as a markdown bullet list.\n\nAudience:\n${text}`,
  landing_faq: (text) =>
    `Write a landing-page FAQ section. 6 Q&A pairs covering: pricing, security, comparison, refunds, integrations, support. Reply as markdown '**Q:**' / '**A:**' pairs.\n\nProduct:\n${text}`,
  landing_feature_grid: (text) =>
    `Write copy for a 3x2 feature grid (6 features). For each: **Icon hint** (emoji), **Headline** (under 5 words), **Body** (under 90 chars). Reply as markdown.\n\nProduct:\n${text}`,
  pricing_faq: (text) =>
    `Write a pricing-page FAQ (5 Q&A). Cover: per-seat vs flat, trial details, billing cycle, downgrade behavior, taxes. Markdown '**Q:**' / '**A:**'.\n\nContext:\n${text}`,
  comparison_grid: (text) =>
    `Build a 3-product comparison grid. Markdown table | Capability | Ours | Competitor A | Competitor B |, 6-8 rows. Be fair, not slanted.\n\nProduct + competitors:\n${text}`,
  vp_canvas: (text) =>
    `Run an Osterwalder Value Proposition Canvas. Markdown sections: **Customer profile** with three sub-bullets (Jobs / Pains / Gains, each with 3 bullets); **Value map** with three sub-bullets (Products & services / Pain relievers / Gain creators, each with 3 bullets).\n\nContext:\n${text}`,
  jtbd: (text) =>
    `Write 3 Jobs-to-be-Done statements in the format 'When [situation], I want to [motivation], so I can [outcome].' Reply as a markdown bullet list.\n\nContext:\n${text}`,
  north_star_narrative: (text) =>
    `Write a north-star + 5-year narrative. Markdown sections: **North-star metric** (one sentence + definition), **5-year vision** (one paragraph), **Year-1 milestones** (3 bullets).\n\nContext:\n${text}`,
  customer_journey: (text) =>
    `Map a customer journey. Markdown stages: **Awareness**, **Consideration**, **Onboarding**, **Habit**, **Advocacy**. For each: customer thoughts (1 line), customer actions (1 line), our touchpoint (1 line), risk (1 line).\n\nProduct:\n${text}`,
  pain_relief_list: (text) =>
    `For each customer pain, list one immediate relief we can ship and one longer-term fix. Reply as markdown bullets formatted '- **Pain** — Quick relief: … / Longer-term: …'. 4-6 bullets.\n\n${text}`,
  aha_moment: (text) =>
    `Propose 3 candidate 'aha moments' for the product — the specific in-product event where a user first feels the value. For each: name, trigger, why it matters, how to instrument it. Reply as markdown.\n\nProduct:\n${text}`,
  activation_events: (text) =>
    `List 5 activation events to track. For each: **Event name** (snake_case), **Trigger condition**, **Why it signals activation**, **How to measure (SQL hint)**. Reply as markdown.\n\nProduct:\n${text}`,
  funding_roadmap: (text) =>
    `Sketch a fundraising roadmap. Markdown rows for each stage: **Stage** (pre-seed / seed / Series A / B), **Target raise**, **Use of funds**, **Milestones unlocked**, **Best investor type**.\n\nContext:\n${text}`,
  saas_pricing_page: (text) =>
    `Write a full SaaS pricing page. Markdown sections: **Hero headline**, **Plans** (3 plans with name, price, who it's for, 5 included features each), **Add-ons**, **Enterprise band**, **FAQ** (4 items), **Trust strip**.\n\nContext:\n${text}`,
  usage_pricing: (text) =>
    `Design a usage-based pricing model. Markdown sections: **Unit of value** (what we charge per), **Tiers** (free / pay-as-you-go / committed), **Overage handling**, **Cost predictability tools** (caps, alerts).\n\nProduct:\n${text}`,
  trial_conversion_email: (text) =>
    `Draft a trial-ending conversion email (4-5 sentences). Recap one specific value moment, surface the chosen plan, low-friction upgrade CTA placeholder, polite alternative for 'not yet'. Subject first.\n\nContext:\n${text}`,
  feat_deprecation_roadmap: (text) =>
    `Lay out a feature-deprecation roadmap. Markdown table | Feature | Status (active / sunsetting / removed) | Sunset date | Replacement | Owner |, 4-6 rows.\n\n${text}`,
  launch_day_checklist: (text) =>
    `Write a launch-day checklist (06:00–22:00). Markdown checkboxes under bold **Pre-launch (T-2h)**, **Launch hour**, **First 4 hours**, **EOD wrap**.\n\nProduct:\n${text}`,
  product_hunt_launch: (text) =>
    `Draft Product Hunt launch copy. Markdown sections: **Tagline** (under 60 chars), **First comment** (3 paragraphs), **3 reply templates** (for praise, criticism, comparison), **Outreach DM** to hunters.\n\nProduct:\n${text}`,
  changelog_blog_post: (text) =>
    `Rewrite the release notes as a 400-500 word blog post. Personal voice, narrative arc (what we shipped, why it matters, what's coming next). End with a CTA paragraph.\n\nNotes:\n${text}`,
  release_tweet_thread: (text) =>
    `Write a 5-tweet launch thread. Each tweet under 280 chars, numbered '1/5'. Hook in tweet 1, value beats in 2-4, CTA + link placeholder in 5.\n\nLaunch:\n${text}`,
  dev_blog_post: (text) =>
    `Write a 700-800 word engineering blog post. Markdown with at least 3 H2 sections (problem, approach, what we learned), 1 code snippet placeholder, 1 trade-off paragraph. Tone: honest, specific.\n\nTopic:\n${text}`,
  api_doc_endpoint: (text) =>
    `Document a single API endpoint. Markdown sections: **Method + path**, **Description**, **Request** (params + body schema), **Response** (200 + 4xx + 5xx with examples in fenced JSON), **Errors**, **Rate limits**, **cURL example**.\n\n${text}`,
  cli_tutorial: (text) =>
    `Write a 5-minute CLI tutorial for the tool. Markdown sections: **Install**, **Hello world** (one command), **Common workflow** (3 commands in sequence), **Where to go next**. Use fenced \`\`\`bash blocks.\n\nTool:\n${text}`,
  sdk_getting_started: (text) =>
    `Write an SDK 'getting started' page. Markdown sections: **Install** (npm/pip/etc), **Authenticate** (env var + code snippet), **First request** (working example), **Error handling**, **Where to go from here**. Use fenced code blocks.\n\nSDK:\n${text}`,
  ux_microcopy: (text) =>
    `Suggest 10 UI microcopy snippets for the product described. Reply as a markdown table | Where | Copy |, 10 rows (button labels, hint text, empty states, errors mixed).\n\nProduct:\n${text}`,
  dialog_confirm: (text) =>
    `Write copy for a destructive-action confirm dialog. Markdown labels: **Title** (under 8 words), **Body** (1-2 sentences explaining what will happen), **Confirm button** (action verb), **Cancel button**.\n\nAction:\n${text}`,
  form_error: (text) =>
    `Write 10 form-field error messages for common validation cases (required, email, password length, mismatch, taken, invalid format, server down, rate limit, banned, expired). Reply as a markdown bullet list, each '- **case** — message'.\n\nContext:\n${text}`,
  tooltip_copy: (text) =>
    `Suggest 5 tooltip strings for the controls described. Each under 70 chars, action-oriented. Reply as a markdown bullet list.\n\nControls:\n${text}`,
  onboarding_tooltip_seq: (text) =>
    `Outline a 7-tooltip onboarding tour. For each: **Step N — Anchor**, then one-line coach-mark copy and a 2-word CTA. Reply as markdown.\n\nProduct:\n${text}`,
  empty_state_variations: (text) =>
    `Write the same empty-state copy in 3 tones: **Encouraging**, **Playful**, **Minimal**. Each: title + body + CTA.\n\nScreen:\n${text}`,
  loading_skeleton_text: (text) =>
    `Suggest 8 short loading messages (under 40 chars each) for the product. Mix calm and lightly humorous. Reply as a markdown numbered list.\n\nProduct:\n${text}`,
  cta_variants: (text) =>
    `Write 6 CTA button copy variants for the goal below. Mix angles (benefit, urgency, soft, command, FOMO, question). Reply as a markdown bullet list, each under 4 words.\n\nGoal:\n${text}`,
  banner_promo: (text) =>
    `Write a top-of-page promo banner. Markdown labels: **Body** (under 90 chars), **CTA** (2-3 words), **Optional dismiss text**.\n\nPromo:\n${text}`,
  sale_headline: (text) =>
    `Write 5 sale headlines (each under 70 chars). Mix discount-first, urgency, value-add. Reply as a markdown numbered list.\n\nSale:\n${text}`,
  seasonal_campaign: (text) =>
    `Plan a seasonal campaign. Markdown sections: **Theme**, **Audience**, **Hero copy** (headline + sub), **Channel mix** (3 bullets), **Promo offer**, **Timeline** (T-14, T-7, T-0, T+7).\n\nSeason/event:\n${text}`,
  referral_program_copy: (text) =>
    `Write the customer-facing copy for a referral program. Markdown sections: **Headline**, **How it works** (3 numbered steps), **Reward (both sides)**, **FAQ** (3 items), **Share message templates** (email + SMS).\n\nProgram:\n${text}`,
  discount_code_email: (text) =>
    `Draft a discount-code email. Subject first, then 3-4 sentence body: friendly greeting, what the code is + how much off, code in a styled callout, expiry date, single CTA. Reply as markdown.\n\nContext:\n${text}`,
  affiliate_terms: (text) =>
    `Draft a simple affiliate program terms doc. Markdown sections: **Eligibility**, **Commission**, **Cookie duration**, **Prohibited tactics**, **Payment terms**, **Termination**. Keep it plain.\n\nContext:\n${text}`,
  terms_of_service: (text) =>
    `Draft a plain-language ToS skeleton (NOT legal advice; placeholder). Markdown sections: **Acceptance**, **Account**, **Acceptable use**, **Subscriptions & billing**, **Termination**, **Disclaimers**, **Limitation of liability**, **Governing law**, **Changes**.\n\nProduct:\n${text}`,
  privacy_policy: (text) =>
    `Draft a privacy policy skeleton (NOT legal advice; placeholder). Markdown sections: **Information we collect**, **How we use it**, **Sharing**, **Cookies**, **Your rights**, **Retention**, **Security**, **Children**, **Contact**.\n\nProduct:\n${text}`,
  eula: (text) =>
    `Draft an EULA skeleton (NOT legal advice). Markdown sections: **License grant**, **Restrictions**, **Ownership**, **Updates**, **Termination**, **Warranty disclaimer**.\n\nSoftware:\n${text}`,
  sla_template: (text) =>
    `Draft an SLA template. Markdown sections: **Service description**, **Uptime commitment** (e.g. 99.9%), **Measurement window**, **Credits schedule**, **Exclusions**, **How to claim credits**.\n\nService:\n${text}`,
  acceptable_use: (text) =>
    `Write an Acceptable Use Policy. Markdown sections: **Allowed use**, **Prohibited content/activity** (5-7 bullets), **Reporting**, **Consequences**, **Right to investigate**.\n\nContext:\n${text}`,
  return_policy: (text) =>
    `Write a returns policy in plain language. Markdown sections: **Window**, **Condition required**, **Refund vs exchange**, **How to start a return**, **Who pays return shipping**, **Non-returnable items**.\n\nContext:\n${text}`,
  shipping_policy: (text) =>
    `Write a shipping policy. Markdown sections: **Processing time**, **Domestic options + costs**, **International**, **Tracking**, **Lost/stolen package process**, **Customs note**.\n\nContext:\n${text}`,
  warranty_terms: (text) =>
    `Write a product warranty. Markdown sections: **Coverage period**, **What's covered**, **What isn't**, **How to claim**, **Repair vs replacement vs refund**, **Limits of liability**.\n\nProduct:\n${text}`,
  agency_pitch_deck: (text) =>
    `Outline an agency pitch deck responding to an RFP. Reply as 10 markdown bullets, each 'Slide N — Title: 1-sentence content'.\n\nRFP:\n${text}`,
  freelance_quote: (text) =>
    `Draft a freelance quote email. 4 short paragraphs: appreciate the brief, summarize understanding, propose deliverables + price + timeline, request a signed SOW. Subject first.\n\nContext:\n${text}`,
  client_onboarding: (text) =>
    `Outline a new-client onboarding flow. Markdown sections: **Kickoff call agenda**, **Documents to collect**, **Communication setup**, **Project plan delivery (T+7)**, **First check-in (T+14)**.\n\nClient context:\n${text}`,
  invoice_narrative: (text) =>
    `Write a 2-paragraph cover note to attach with an invoice. Reaffirm value delivered, thank for the project, note payment terms politely. Reply with the note only.\n\nContext:\n${text}`,
  copywriter_feedback: (text) =>
    `Act as a senior copywriter reviewing the text below. Give 5 sharp, specific notes — call out weak verbs, vague claims, missing hook, voice drift, or rhythm issues. For each note: quote the offending phrase, say why it underperforms, suggest a tighter rewrite. Reply as a markdown bullet list.\n\nText:\n${text}`,
  editor_rewrite: (text) =>
    `Act as a strict literary editor. Rewrite the text below: tighten every sentence, strip filler, vary sentence length, lift verbs, kill clichés, keep voice and meaning intact. Reply with two markdown sections: '**Rewrite**' (the revised text only) and '**Editor's notes**' (3-4 bullets on what changed and why).\n\nText:\n${text}`,
  translate_batch: (text) =>
    `Translate the text below into English, Korean (한국어), Japanese (日本語), and Spanish, preserving meaning, tone, and any technical terms. Reply as markdown with four H2 sections '## English', '## 한국어', '## 日本語', '## Español' each containing the translated text in natural register.\n\nText:\n${text}`,
  transliterate: (text) =>
    `Transliterate proper nouns in the text below into Korean Hangul phonetics (외래어 표기). For each name: '- **Original** → 한글 표기 (rough pronunciation)'. Skip common English words. If text already has Hangul names, do the reverse (Hangul → Romanization). Reply as markdown bullets only.\n\nText:\n${text}`,
  native_rewrite: (text) =>
    `Rewrite the text below so it reads as if written by a native speaker of its language — fix awkward phrasing, unnatural collocations, stiff translations, register slips. Preserve meaning. Reply with two markdown sections: '**Native rewrite**' (revised text only) and '**Why it sounded off**' (2-3 bullets pointing to specific phrases).\n\nText:\n${text}`,
  honorific_ko: (text) =>
    `Rewrite the Korean text below into proper 존댓말 (격식체 / 합쇼체) suitable for addressing a senior colleague or client. Use '~습니다 / ~십니다' endings, polite vocabulary, and respectful address. If the text is in English, translate it into formal Korean. Reply with the rewritten text only — no preamble.\n\nText:\n${text}`,
  casual_ko: (text) =>
    `Rewrite the Korean text below into casual 반말 (해체) — friendly, peer-to-peer Korean as you'd write to a close friend. Use '~야 / ~지 / ~어' endings, drop unnecessary honorifics, keep warmth. If the text is in English, translate naturally into casual Korean. Reply with the rewritten text only.\n\nText:\n${text}`,
  business_ko: (text) =>
    `Rewrite the text below as polished Korean business writing (비즈니스 한국어). Use 합쇼체, neutral professional tone, concise sentences, and standard business idioms ('~드립니다', '검토 부탁드립니다', '협조 부탁드립니다'). If input is English, translate to Korean business register. Reply with the rewritten text only.\n\nText:\n${text}`,
  email_ko_polite: (text) =>
    `Draft a polite Korean business email (정중한 비즈니스 메일) from the context below. Use 합쇼체 throughout. Structure: greeting ('안녕하세요, …'), one-sentence reason for writing, main content (2-3 short paragraphs), polite close ('감사합니다.\\n홍길동 드림'). Subject line ('제목:') on the first line, blank line, then body. Reply with the email only.\n\nContext:\n${text}`,
  kakao_msg: (text) =>
    `Rewrite the context below as a short KakaoTalk message (카톡 메시지). Natural conversational Korean, 2-4 short lines, occasional ~ or ㅋㅋ where it fits, no formal sign-off. Match the relationship implied by the context (friend = 반말, colleague = 가벼운 존댓말). Reply with the message only — no quotes, no preamble.\n\nContext:\n${text}`,
  announcement_ko:  (text) =>
    `Write a clear, polite Korean announcement (공지사항) from the context. Structure: title on the first line ('[공지] …'), blank line, 3-5 short paragraphs (배경 / 변경 사항 / 시행일 / 문의처), close with '감사합니다.' Use 합쇼체 throughout. Reply with the announcement only.\n\nContext:\n${text}`,
  biz_card_bio: (text) =>
    `Write a business-card-sized professional bio (under 200 characters) for the subject described. Third person, name first, then role + company, then one specific credential or focus area. Reply with just the bio line, no quotes.\n\nContext:\n${text}`,
  elevator_mom_test: (text) =>
    `Rewrite the elevator pitch / explanation below so your mom (or any smart non-expert) would understand it in 30 seconds. Strip jargon, use one everyday analogy, lead with the human problem. Reply with two markdown sections: '**Mom-test version**' (the rewritten pitch, 3-4 sentences) and '**Words I had to drop**' (3-5 bullets listing the jargon swapped out, with the plain substitute).\n\nContext:\n${text}`,
  yo_style_ko: (text) =>
    `Rewrite the text below in soft Korean 해요체 — polite but warm and approachable (~해요 / ~예요 / ~네요 endings). Avoid both rigid 합쇼체 and casual 반말. If input is English, translate naturally into 해요체 Korean. Reply with the rewritten text only — no preamble.\n\nText:\n${text}`,
  grandma_explain: (text) =>
    `Explain the concept below as if telling your grandmother — warm, patient, using one old-fashioned analogy (e.g. a market stall, a sewing kit, a radio dial) that fits her world. 3-4 short sentences. Reply in the same language as the input. Reply with the explanation only.\n\nConcept:\n${text}`,
  movie_pitch: (text) =>
    `Compress the idea below into a single-line movie logline in the format: '[Genre] · When [protagonist with one trait] [inciting incident], they must [goal] before [stakes/twist].' Under 35 words. Then on a new line give 3 alternate one-line taglines for the poster as a markdown bullet list.\n\nIdea:\n${text}`,
  changelog_from_bullets: (text) =>
    `Rewrite the raw change bullets below into a user-facing changelog entry. Markdown sections: '**🎉 What's new**' (1-2 bullets focused on user benefit), '**🛠 Improved**' (1-3 bullets), '**🐛 Fixed**' (1-3 bullets). Skip empty sections. Keep each bullet under 110 chars and lead with the user-visible outcome, not the implementation.\n\nRaw bullets:\n${text}`,
  contract_summary: (text) =>
    `Summarize the contract / clauses below for a busy non-lawyer. Markdown sections with bold labels: **당사자 / Parties**, **금액 / Fees**, **기간 / Term**, **해지 / Termination**, **위약·책임 / Penalties & Liability**, **유의사항 / Watch-outs** (2-3 bullets). 1-2 lines per section. Keep it neutral — flag risky asymmetric clauses in 'Watch-outs'.\n\nContract:\n${text}`,
  explain_acronym: (text) =>
    `Treat the text below as either an acronym/abbreviation or a sentence containing one. Reply as markdown: '**Full form:**' (the expansion), '**Domain:**' (where it's used), '**Meaning in plain language:**' (1-2 sentences), '**Example sentence:**' (one sentence showing natural use). If multiple acronyms appear, do this for the most prominent one only.\n\nText:\n${text}`,
  dramatize: (text) =>
    `Rewrite the flat text below as a vivid, dramatic version — sharper verbs, sensory detail, stronger stakes, a one-beat cliffhanger at the end. Keep facts intact. Reply with two markdown sections: '**Dramatized**' (the rewritten text) and '**Edits I made**' (3 bullets naming the specific moves used: e.g. 'replaced "went" with "stormed"').\n\nText:\n${text}`,
  karaoke_lyrics: (text) =>
    `Write a singable 4-line Korean (or English if input is English) karaoke-friendly chorus inspired by the context. Plus 2 extra verse lines that lead into the chorus. Reply as markdown labels '**Verse**' (2 lines) then '**Chorus** ×2' (the 4 chorus lines). Lines should match a regular 8-10 syllable feel.\n\nContext:\n${text}`,
  legal_plain_ko: (text) =>
    `Rewrite the legal clause(s) below in plain Korean (쉬운 한국어) that a non-lawyer can understand. Replace 한자어/전문용어 with everyday words ('계약 해제' → '계약을 끝낼 수 있어요'). Use 해요체. Keep the legal meaning intact. Reply as markdown: '**쉽게 풀어쓴 조항**' (the rewrite) and '**핵심 포인트**' (2-3 bullets — 권리/의무/주의사항).\n\n조항:\n${text}`,
  yc_pitch: (text) =>
    `Write a 60-second YC-style startup pitch from the context below. 4 sections in this order, each 1-2 sentences with bold labels: **What** (one concrete sentence on what we built — no buzzwords), **Why now** (the timing / unlock), **How (traction)** (one numeric proof point, even rough), **Ask** (what we need next — money, intros, hires). Reply as markdown.\n\nStartup context:\n${text}`,
  meeting_minutes: (text) =>
    `Convert the raw meeting notes/transcript below into formal meeting minutes. Markdown sections with bold labels: **Date / Attendees** (inferred or 'TBD'), **Agenda** (3-5 bullets), **Discussion** (1-2 short paragraphs per topic), **Decisions** (bullet list), **Action items** (markdown checkboxes with owner placeholder and rough due date), **Open questions**. Reply as markdown.\n\nNotes:\n${text}`,
  sprint_retro_detailed: (text) =>
    `Run a DAKI sprint retrospective on the context below. Markdown with four bold sections: **Drop** (3 bullets — stop doing), **Add** (3 bullets — start doing), **Keep** (3 bullets — continue doing well), **Improve** (3 bullets — change but don't drop). End with one bold takeaway sentence labeled **Top priority for next sprint:**.\n\nContext:\n${text}`,
  user_story_acceptance: (text) =>
    `Write a user story plus Gherkin acceptance criteria for the feature below. Markdown: '**User story:**' single line in the format 'As a <persona>, I want <capability>, so that <benefit>.'  Then '**Acceptance criteria**' as 5 bullets, each in 'Given … When … Then …' format. Cover happy path, one edge case, one error case, one accessibility case, one performance case.\n\nFeature:\n${text}`,
  bug_repro: (text) =>
    `Turn the loose bug description below into a clean reproducibility report. Markdown sections with bold labels: **Summary** (one sentence, no jargon), **Environment** (OS / browser / app version / device — leave 'TBD' if unknown), **Steps to reproduce** (numbered, 3-6 steps), **Expected**, **Actual**, **Frequency** (Always / Sometimes / Rare), **Workaround** (if any). Reply as markdown.\n\nDescription:\n${text}`,
  api_mock_response: (text) =>
    `Read the API endpoint description below and produce 3 realistic mock JSON response variants in this order: a **success** (200), a **partial / edge case**, and an **error** (4xx). Wrap each in its own fenced \`\`\`json block, with a bold label above (e.g. '**200 OK**'). Field types should match the endpoint's shape; pick plausible non-PII sample values.\n\nEndpoint:\n${text}`,
  changelog_merge: (text) =>
    `Merge the multiple PR / commit notes below into a single user-facing changelog entry. Deduplicate overlapping changes, drop internal refactors, and reframe in user benefit terms. Markdown sections: **🎉 Highlights** (1-3 bullets), **✨ New**, **🛠 Improved**, **🐛 Fixed**, **⚠️ Breaking** (skip empty sections). Each bullet under 110 chars.\n\nRaw notes:\n${text}`,
  customer_followup_ko: (text) =>
    `Write a warm Korean customer follow-up message (고객 후속 메시지) for the context below. Use polite 해요체. Open with a brief reference to the prior interaction (구매/문의/상담), check satisfaction in one line, offer a concrete next step (additional help, 후기 요청, 추천 등), close warmly. 4-6 sentences. Reply with the message only.\n\nContext:\n${text}`,
  release_blog_ko: (text) =>
    `Rewrite the release notes below as a Korean blog post (300-400자) in 합쇼체 / 해요체 mix. Structure: 한 줄 hook intro, 핵심 변경 사항 2-3개 (각각 짧은 H3 + 1-2문장), 사용자에게 의미하는 바 1단락, 다음 단계 (CTA 1줄). Use natural Korean tech blog tone — avoid mechanical translations. Reply as markdown.\n\nRelease notes:\n${text}`,
  sql_from_schema: (text) =>
    `Read the schema + question below. Reply with a single Postgres-compatible SQL query inside a fenced \`\`\`sql block that answers the question. After the block: '**How it works:**' 2-3 sentence plain-language explanation, then '**Assumptions:**' (1-2 bullets on what you inferred from the schema if anything was ambiguous).\n\nSchema + question:\n${text}`,
  excel_formula: (text) =>
    `Given the intent described below, reply with a single Excel/Google Sheets formula on its own line (starting with '='). Then below it, markdown sections: '**What it does**' (one sentence), '**Inputs**' (bullet list mapping cell refs to their role, e.g. '- A2: order amount'), '**Variants**' (1-2 alternative formulas for related needs).\n\nIntent:\n${text}`,
  onboarding_survey_ko: (text) =>
    `Design a 5-question Korean onboarding survey (온보딩 설문) for the product / service described. Mix question types: 1) Likert (1-5점), 2) 다지선다, 3) 순위 매기기, 4) 단답형 (1-2 문장), 5) 자유 응답. Use 해요체. Each question on its own bold line with the type label in parens '(리커트 1-5)'. Add a brief intro sentence at the top and a closing thank-you line. Reply as markdown.\n\nContext:\n${text}`,
  refund_letter_ko: (text) =>
    `Write a polite, firm Korean refund-request letter (환불 요청서) based on the context. Structure: '제목: …' first line, blank, then 4-5 short paragraphs in 합쇼체 — 구매 사실 명시 (상품/일자/금액), 환불 사유 (간결, 감정 X), 관련 법령/약관 근거 (있으면 인용), 환불 요청 + 기한, 정중한 마무리. End with '○○○ 드림' placeholder. Reply with the letter only.\n\nContext:\n${text}`,
  news_summary_ko: (text) =>
    `Summarize the Korean (or any-language) news article below into exactly 3 short Korean sentences in 합쇼체. Cover: 1) 핵심 사실 (누가/무엇을), 2) 배경/원인, 3) 영향/전망. Then on a new line, add '**핵심 키워드:**' followed by 5 comma-separated Korean keywords. Reply as markdown.\n\nArticle:\n${text}`,
  recipe_shopping_list: (text) =>
    `Extract a shopping list from the recipe(s) below, grouped by store section. Markdown sections with bold labels: **농산물 / Produce**, **육류·수산 / Meat & seafood**, **유제품·달걀 / Dairy & eggs**, **건조식품·곡류 / Pantry**, **양념·소스 / Sauces & spices**, **기타 / Misc**. Each bullet shows quantity + item. Skip empty sections. Aggregate duplicates from multiple recipes.\n\nRecipe(s):\n${text}`,
  podcast_guest_questions: (text) =>
    `Generate 10 thoughtful podcast interview questions for the guest described below. Mix angles: origin story, current focus, contrarian take, recent failure, one tactical how-to, future-of-field, personal habit, a question only this guest could answer, audience Q-bait, closing reflection. Reply as a markdown numbered list, no preamble.\n\nGuest:\n${text}`,
  email_subject_5: (text) =>
    `Read the email body below and write 5 alternative subject lines under 60 chars each. Vary the angle: 1) benefit-led, 2) curiosity, 3) question, 4) urgency / specific date, 5) low-key personal. Reply as a markdown numbered list with the angle label in italic after each, e.g. '1. Subject line — *benefit*'.\n\nEmail body:\n${text}`,
  research_summary: (text) =>
    `Summarize the research paper / abstract below in a 4-section structured note. Markdown with bold labels: **Problem** (what was the gap or question), **Method** (study design, sample, key tools — 1-2 lines), **Result** (the headline finding + 1-2 numbers if present), **Limitations / open questions** (1-2 bullets). Stay neutral; do not embellish.\n\nPaper:\n${text}`,
  tough_questions: (text) =>
    `Read the pitch / proposal / argument below. Generate 5 tough audience questions a critical reviewer would ask. Mix: an evidence question, a comparison question, an assumption-buster, a 'what if you're wrong' scenario, a follow-the-money question. Reply as a markdown numbered list, each question 1 sentence. Add a one-line '**Suggested honest answer**' under each.\n\nContext:\n${text}`,
  legalese_detect: (text) =>
    `Scan the legal text below for risky, one-sided, or unusually broad clauses. Reply as a markdown table with columns | Clause type | Why it matters | Negotiation lever |. 4-6 rows. Cover liability caps, indemnity scope, termination asymmetry, IP assignment, auto-renewal, jurisdiction. End with a single bold '**Top concern:**' sentence.\n\nText:\n${text}`,
  translate_natural_en: (text) =>
    `Translate the Korean (or Japanese / Chinese) text below into natural, idiomatic English that reads like it was originally written in English. Avoid literal word order, soften 한국어/일본어 특유의 격식, replace direct translations with the closest English idiom or register. Reply with two markdown sections: '**Natural English**' (the translation only) and '**Translator's notes**' (2-3 bullets on choices you made and what was lost).\n\nOriginal:\n${text}`,
  safety_review: (text) =>
    `Scan the text below for safety / publication risks. Reply as a markdown table with columns | Category | Risk found? | Snippet | Suggested action |, with rows for: **PII** (names, emails, phone, IDs), **Sensitive data** (financial, health, credentials), **Hate / harassment**, **Defamation risk**, **Copyright snippet (>40 words)**, **Confidential markers** ('NDA', 'internal', etc.). Mark 'None' if clean for a row. End with one bold '**Overall verdict:**' line: 'Safe to publish' / 'Needs review' / 'Do not publish'.\n\nText:\n${text}`,
  style_mirror: (text) =>
    `The text below has TWO parts separated by '---'. The first part is a **style sample** (the voice to mimic). The second part is a **topic / brief** to write about in that same voice. Absorb the sample's sentence length, vocabulary, rhythm, and signature quirks, then write 2-3 paragraphs about the topic. Reply with the new text only.\n\nInput:\n${text}`,
  biz_eng_email: (text) =>
    `Draft a formal business English email from the context below. Subject line on the first line ('Subject: …'), blank line, then 4-5 sentences: clear opening with reason for writing, one paragraph of context/ask, a specific next step with date, a polite close, signature placeholder. Use neutral professional register — no exclamation marks, no 'I hope you are doing well'. Reply with the email only.\n\nContext:\n${text}`,
  intro_ko_formal: (text) =>
    `Write a polite Korean first-meeting self-introduction (정중한 자기소개) from the bio below. 합쇼체. Structure: 인사말 ('안녕하세요. …'), 이름 + 소속/직책 (한 문장), 현재 하는 일 (한 문장), 만나서 기대하는 점 (한 문장), 마무리 인사 ('잘 부탁드립니다.'). 총 5-6문장. Reply with the intro only.\n\nBio:\n${text}`,
  ui_spec_from_desc: (text) =>
    `Read the UI screen description below and produce a structured component spec. Markdown sections with bold labels: **Component name** (PascalCase), **Purpose** (one sentence), **Elements** (bullet list of each visible element + role), **States** (default / hover / focus / disabled / loading / error / empty — only those that apply), **Interactions** (3-5 bullets), **Accessibility** (keyboard, screen reader, contrast), **Edge cases** (2-3 bullets).\n\nScreen:\n${text}`,
  dad_jokes: (text) =>
    `Write 3 dad jokes (아재 개그) related to the topic below. Each one a setup line + punchline on the next line. Keep them family-friendly and groan-worthy in the classic dad-joke way. If the topic is Korean, write Korean 아재 개그 (말장난 포함); otherwise English dad jokes. Reply as markdown with each joke labeled '**Joke 1**', '**Joke 2**', '**Joke 3**'.\n\nTopic:\n${text}`,
  jp_business_polite: (text) =>
    `Rewrite the text below as polite Japanese business communication (敬語 — 丁寧語 + 尊敬語/謙譲語 where appropriate). Use natural ビジネスメール conventions: 「お世話になっております」style openings, 「〜いただけますでしょうか」style requests, 「よろしくお願いいたします」close. If input is English/Korean, translate into proper Japanese business register. Reply with the rewritten text only, then a brief '**注記**' bullet list (2-3 bullets) noting the 尊敬語/謙譲語 swaps you made.\n\nText:\n${text}`,
  git_conflict_resolve: (text) =>
    `The text below contains a git merge conflict (with <<<<<<<, =======, >>>>>>> markers). Reply with: 1) a fenced code block containing the **suggested resolution** (the merged code, conflict markers removed), 2) '**Why this resolution**' — 2-3 sentences explaining which side won and why, 3) '**What to double-check**' — 2 bullets on edge cases the human should verify.\n\nConflict:\n${text}`,
  copy_3_tones: (text) =>
    `Rewrite the copy below three times in different tones. Markdown with three bold sections: **Formal** (corporate, no contractions, neutral), **Playful** (warm, light humor, conversational contractions OK), **Punchy** (short sentences, strong verbs, no fluff — under 60% of original length). Preserve facts and asks. Reply with the three versions only.\n\nCopy:\n${text}`,
  sql_explain_ko: (text) =>
    `Explain the SQL query below in Korean using 해요체, step by step. Markdown structure: '**한 줄 요약**' (이 쿼리가 뭘 가져오는지 한 문장), '**단계별 분석**' (FROM / JOIN / WHERE / GROUP BY / ORDER BY 등 순서대로 bullet — 사용된 절만), '**주의할 점**' (성능, NULL 처리, edge case — 1-3 bullets). Reply as markdown.\n\nQuery:\n${text}`,
  jira_from_bug: (text) =>
    `Convert the loose bug description below into a Jira-ready ticket. Markdown sections with bold labels: **Summary** (under 80 chars, present tense, no period), **Description** (Steps to reproduce / Expected / Actual / Environment as sub-bullets), **Acceptance criteria** (3-5 markdown checkboxes '- [ ] ...'), **Priority** (P0-P3 + one-line justification), **Labels** (comma-separated, lowercase-kebab). Reply as markdown.\n\nBug description:\n${text}`,
  slack_rephrase_ko: (text) =>
    `Rewrite the long message below as a casual 3-line Korean Slack message in 해요체. Lines: 1) 핵심 한 줄 (왜 쓰는지 / 무엇이 결정/필요한지), 2) 짧은 맥락 (필요하면 숫자/링크 placeholder), 3) 행동 요청 ('이거 확인 부탁드려요!' 같은 한 줄). Casual emoji 0-1개 OK. Reply with just the 3 lines.\n\nOriginal:\n${text}`,
  pitch_slide_titles: (text) =>
    `Produce 10 pitch-deck slide titles + one-line content each, in the YC / Sequoia order: 1) Company purpose, 2) Problem, 3) Solution, 4) Why now, 5) Market size, 6) Competition, 7) Product, 8) Business model, 9) Team, 10) The ask. Reply as a markdown numbered list, each line formatted '**N. Title** — one-sentence content'.\n\nContext:\n${text}`,
  customer_quote_ko: (text) =>
    `Write 3 short, distinct Korean customer testimonials (고객 사용 후기) for the offering below — each from a different persona. Use 해요체. Each quote 1-2 sentences with one concrete outcome (시간 절약 / 만족도 / 성과 수치 placeholder). Reply as markdown bullets formatted '- "…" — 페르소나, 직책 / 상황'. Personas: 1) 실무 담당자, 2) 의사결정권자, 3) 신규 사용자.\n\nOffering:\n${text}`,
  release_go_no_go: (text) =>
    `Write a release Go/No-Go decision memo from the context below. Markdown sections with bold labels: **Release**, **Date**, **Owner**, **Open blockers** (table | Issue | Severity | Owner | ETA |, 2-4 rows or 'None'), **Risks accepted** (3 bullets), **Rollback plan** (3 short steps), **Comms ready?** (checkboxes for changelog / blog / support / status), **Decision: Go / No-Go** + one-sentence justification.\n\nContext:\n${text}`,
  icp_profile: (text) =>
    `Build a 1-page Ideal Customer Profile from the context. Markdown sections: **Firmographics** (industry, company size, geography, revenue band), **Buyer persona** (title, seniority, team), **Pain points** (3 bullets), **Trigger events** (3 bullets — what makes them start looking), **Buying process** (decision-maker, influencer, evaluator, blocker), **Anti-ICP** (3 bullets — who NOT to target).\n\nContext:\n${text}`,
  competitive_moat: (text) =>
    `Identify the offering's 3 strongest competitive moats. For each, markdown structure: '### Moat: [name]', then bullets — **Why it's defensible**, **How fast a competitor could copy it (months)**, **Metric we can track to prove it widening over time**, **Biggest risk to this moat**. Keep each bullet short.\n\nOffering:\n${text}`,
  postmortem_ko: (text) =>
    `Draft a Korean blameless postmortem (장애 회고) from the context. Use 합쇼체. Markdown sections: **요약** (1-2문장), **영향** (사용자 수 / 지속 시간 / 손실 추정), **타임라인** (시간 순 bullet, 'HH:MM — …'), **근본 원인**, **잘된 점** (3 bullets), **개선할 점** (3 bullets), **액션 아이템** ('- [ ] 담당: ○○○ / 기한: YYYY-MM-DD' 형식, 3-5개). 비난조 금지, 시스템 관점 유지.\n\n맥락:\n${text}`,
  headline_rewrite_ko: (text) =>
    `Rewrite the Korean (or any-language) headline below in 5 different angles. Each under 35자, in 합쇼체. Markdown numbered list with the angle label in italic after each: 1) **호기심**, 2) **혜택 중심**, 3) **숫자/구체성**, 4) **대비/before-after**, 5) **질문형**. Reply as: '1. 헤드라인 — *호기심*' style.\n\n원본 헤드라인:\n${text}`,
  email_decline_ko: (text) =>
    `Draft a polite Korean email declining the request in the context. Use 합쇼체. Structure: 제목 ('제목: 회신 - …'), blank, 4 short paragraphs — 1) 감사 인사 + 요청 수신 확인, 2) 정중한 거절 + 구체적 사유 (변명조 X), 3) 가능한 대안 1개 (소개·다음 기회·자료 공유 등), 4) 관계 유지 마무리. End with '○○○ 드림' placeholder. Reply with the email only.\n\n요청 맥락:\n${text}`,
  api_docs_from_code: (text) =>
    `Read the function / endpoint signature below and produce API reference docs in markdown. Sections: **Signature** (fenced code block of the signature), **Description** (1-2 sentences on what it does and when to use it), **Parameters** (table | Name | Type | Required | Description |), **Returns** (type + 1 sentence), **Throws / errors** (bulleted list, or 'None'), **Example** (fenced code block with a realistic call + expected output).\n\nCode:\n${text}`,
  db_schema_naming: (text) =>
    `Read the entity / domain description below and propose a database naming scheme. Markdown sections: **Tables** (bullet list of table names in snake_case_plural with 1-line purpose each), **Columns** (per-table bullets formatted '- table.column — type — purpose'), **Foreign keys** (bullets like 'orders.user_id → users.id'), **Indexes worth adding** (3 bullets with why). Keep names short, consistent, and avoid reserved words.\n\nDomain:\n${text}`,
  translate_formal_en: (text) =>
    `Translate the text below into formal business English. Use complete sentences, no contractions, no exclamation marks, restrained vocabulary suitable for a regulator, board member, or external counterparty. Preserve meaning exactly. Reply with the translation only — no preamble.\n\nOriginal:\n${text}`,
  translate_formal_ko: (text) =>
    `Translate / rewrite the text below into formal Korean (격식체 합쇼체). Use 한자어 where they add precision (해당 / 관련 / 별도 / 협조), avoid 구어체, no 이모지. Suitable for 공문 / 공식 메일 / 공지. Preserve meaning exactly. Reply with the translation only.\n\nOriginal:\n${text}`,
  customer_segments: (text) =>
    `Read the product / market context below and propose 3-4 distinct customer segments. For each: markdown '### Segment N: [short name]', then bullets — **Who they are** (firmographic + role), **Top job-to-be-done**, **Why they'd pick us**, **Why they'd churn**, **Rough size & priority for us** (S/M/L). End with one bold '**Where to focus first:**' sentence.\n\nContext:\n${text}`,
  email_thread_summary: (text) =>
    `Summarize the long email thread below for someone catching up. Markdown sections with bold labels: **Participants** (names + roles, comma-separated), **What was discussed** (3-5 bullets), **Decisions made** (bullets, or 'None'), **Open questions** (bullets, or 'None'), **Action items** (markdown checkboxes with owner placeholder and rough due date), **Where we left off** (one sentence on the latest reply).\n\nThread:\n${text}`,
  pr_review_checklist: (text) =>
    `Read the PR description below and generate a tailored review checklist for the reviewer. Markdown grouped under bold sections, each with 2-4 checkbox bullets ('- [ ] …'): **Functional correctness**, **Tests**, **Edge cases**, **Security**, **Performance**, **Backward compatibility**, **Docs & comms**. Only include sections relevant to the change; skip ones that obviously don't apply.\n\nPR:\n${text}`,
  onboarding_30_60_90: (text) =>
    `Build a 30/60/90-day onboarding plan for a new hire in the role below. Markdown with three bold sections: **Day 1-30 (Learn)**, **Day 31-60 (Contribute)**, **Day 61-90 (Own)**. Under each: bullet groups **Goals** (3), **Key relationships to build** (2-3 names placeholders + reason), **Expected output** (1-2 concrete deliverables), **How success is measured**.\n\nRole:\n${text}`,
  sales_call_script_ko: (text) =>
    `Draft a Korean sales discovery call script (영업 콜 스크립트) for the offering. Use 해요체. Markdown sections with bold labels: **오프닝 (1분)** — 인사 + 콜 목적 + 시간 양해, **현황 질문 (5분)** — 3-4개 질문 bullets, **니즈 발굴 (10분)** — pain point 캐치 질문 4개, **가치 제시 (5분)** — 우리 솔루션이 그 페인에 어떻게 fit하는지 2-3 문장, **CTA (2분)** — 다음 단계 제안 (데모 / 후속 미팅 / 자료 발송) + 마무리 인사.\n\n맥락:\n${text}`,
  contract_redline: (text) =>
    `Read the contract clause(s) below and propose redline edits. For each problematic clause: markdown structure — '### Clause: [short name]', then '**현재 / Current:**' (quote the original, fenced as a > blockquote), '**제안 / Proposed:**' (fenced > blockquote of the rewrite), '**근거 / Rationale:**' (1-2 sentences on why the change protects us). 3-5 clauses. End with '**우선순위 / Priority:**' line ranking the top 2 most important.\n\nContract:\n${text}`,
  spec_to_test_cases: (text) =>
    `Read the spec / PRD below and produce a test case matrix. Reply as a markdown table with columns | ID | Category | Given | When | Then | Priority |. Cover 8-12 rows mixing happy path, edge case, error path, accessibility, and performance. ID format 'TC-01', 'TC-02'. Category from: Functional / Edge / Error / Auth / A11y / Perf. Priority P0-P2.\n\nSpec:\n${text}`,
  log_pattern_detect: (text) =>
    `Analyze the log snippet below for patterns and anomalies. Markdown sections: **Top patterns** (3-5 bullets describing repeating messages with rough counts), **Anomalies / one-off errors** (2-3 bullets), **Likely root cause hypothesis** (1-2 sentences), **Suggested alerts** (table | Signal | Threshold | Window | Severity | covering 3-4 rows). Keep tone neutral and evidence-based.\n\nLog:\n${text}`,
  regression_risk: (text) =>
    `Given the change description below, identify regression risk areas. Markdown sections: **Areas likely affected** (3-5 bullets — name modules / flows / features), **Why each is at risk** (1 sentence per bullet), **Suggested verification** (markdown checkboxes — manual checks + automated tests to run), **Rollback complexity** (Low / Medium / High + 1 sentence). Be specific to the diff — avoid generic advice.\n\nChange:\n${text}`,
  db_migration_plan: (text) =>
    `Plan a zero-downtime database migration for the schema change below. Markdown numbered steps (6 phases, each with a bold label): 1) **Backfill prep** (add new column nullable / new index online), 2) **Dual-write** (app writes both old and new), 3) **Backfill** (batched, idempotent script), 4) **Verify parity** (counts + sample diffs), 5) **Read swap** (flag-flipped), 6) **Cleanup** (drop old column / index). Each step gets 2-3 bullet sub-points covering action + rollback path + observability check.\n\nSchema change:\n${text}`,
  marketing_positioning: (text) =>
    `Build a 2x2 marketing positioning quadrant for the offering. Axes you pick (label them — e.g. 'Easy ↔ Powerful', 'Affordable ↔ Premium'). Markdown sections: **Axes** (2 bullets — name + what high/low means), **Map** (markdown table with 4 cells naming a competitor or two in each quadrant), **Where we sit today**, **Where we should move (and why)**.\n\nContext:\n${text}`,
  welcome_pack_ko: (text) =>
    `Draft a 3-email Korean welcome pack (신규 고객 환영팩) for the product. 합쇼체. Markdown with three H2 sections, each containing '**제목:** …' on first line and a 4-5 sentence body. Email order: 1) **Day 0 — 환영 & 첫 단계**, 2) **Day 3 — 핵심 기능 한 가지 깊게**, 3) **Day 7 — 더 활용하는 팁 + 도움 요청 채널**. End each email with a clear single CTA line.\n\nProduct:\n${text}`,
  incident_report_customer: (text) =>
    `Write a customer-facing incident report based on the context. 4-5 short markdown sections with bold labels: **What happened** (1-2 sentences, plain language, no jargon), **Who and what was affected** (be specific about scope + duration), **Why it happened** (honest root cause, no blame), **What we've done since** (3 bullets — immediate fix + prevention), **How we'll keep you informed** (1 sentence). Calm, accountable tone. No corporate hedging.\n\nIncident:\n${text}`,
  team_okr_quarterly: (text) =>
    `Write a quarterly OKR for the team described. Markdown: '## Objective' (one inspirational sentence, 'verb the [outcome]' shape), '## Key Results' (exactly 3 bullets, each measurable with baseline → target → metric source), '## Monthly milestones' (table | Month | Milestone | Owner |, 3 rows for the 3 months of the quarter). End with one bold '**Biggest risk:**' line.\n\nTeam:\n${text}`,
  translate_academic_en: (text) =>
    `Translate the text below into academic English suitable for a peer-reviewed paper. Prefer passive voice for methods, active voice for results, third person throughout. Use precise terminology, hedge appropriately ('suggests', 'indicates', 'is consistent with'), avoid colloquialisms. Reply with two markdown sections: '**Academic English**' (the translation) and '**Notes**' (2-3 bullets on register choices — e.g. terminology decisions, hedging level).\n\nOriginal:\n${text}`,
  sales_objection_handle_ko: (text) =>
    `Generate 5 common Korean sales objections likely to come up for the offering, with a response for each. Markdown bullets formatted '- **이의:** … / **응답:** …'. Cover: 가격, 도입 시점, 도입 부담, 경쟁사 비교, 의사결정 권한. Use 해요체 in responses — warm, confident, acknowledge first then reframe. End with one bold '**핵심 메시지:**' line summarizing what to always come back to.\n\nOffering:\n${text}`,
  competitor_feature_matrix: (text) =>
    `Build a competitor feature matrix for the offering vs 2 named (or generic) competitors. Reply as a markdown table with columns | Feature | Ours | Competitor A | Competitor B |. 5-7 rows of features that matter for buying decisions in this category. Use '✅', '➖' (partial), '❌' as the cell values. After the table, add one bold '**Where we win:**' and '**Where we lose:**' line.\n\nOffering + competitors:\n${text}`,
  jira_from_spec: (text) =>
    `Decompose the spec below into an Epic + 5-8 implementable Jira-style child issues. Markdown structure: '## Epic: [name]' (1 sentence goal), '### Child issues' (numbered list — each with **Title** (under 80 chars), **Estimate** (S/M/L), **Depends on** (issue numbers, or 'None'), **Acceptance** (1 line)). End with a '**Suggested execution order:**' bullet sequence based on dependencies.\n\nSpec:\n${text}`,
  translate_poetic_ko: (text) =>
    `Translate the text below into Korean with poetic sensibility — preserve imagery, rhythm, and sound. Use 해요체 (or 반말 if it fits the source mood). Where literal translation would flatten the meaning, prefer evocative idioms or sound symbolism (의성어/의태어). Reply with two markdown sections: '**시적 번역**' (the translation alone) and '**선택한 표현 노트**' (2-3 bullets on choices — 어떤 단어를 왜 골랐는지).\n\nOriginal:\n${text}`,
  sales_email_cold_ko: (text) =>
    `Draft a Korean cold-outreach sales email (콜드 메일) for the prospect described. Use 합쇼체 (격식). Subject line first ('제목: …'), blank, then 4-5 sentences: 1) 개인화된 한 줄 (그쪽 회사/역할에서 짐작되는 상황 언급), 2) 우리가 누구이며 왜 이메일 보내는지 1줄, 3) 구체적 가치 / 결과 한 줄 (가능하면 숫자), 4) 부담 적은 다음 단계 ('15분 통화 가능하실까요?'), 5) 정중한 마무리. Reply with the email only.\n\nProspect:\n${text}`,
  event_mc_script: (text) =>
    `Write an MC script for the event described. Markdown sections with bold labels: **오프닝** (환영 인사 + 행사 목적 + 첫 세션 소개), **세션 전환** (앞 세션 정리 한 문장 + 다음 세션·연사 소개 1문장 — 3개 transition), **Q&A 진행** (오프닝 멘트 + 청중 유도 멘트 + 마무리 멘트), **마무리** (감사 인사 + 후속 안내 + 송별). 자연스러운 한국어 구어체, 너무 격식 X, 너무 가볍지도 않게.\n\nEvent:\n${text}`,
  incident_rca_5whys: (text) =>
    `Run a 5 Whys root-cause analysis on the incident below. Markdown structure: '**문제 / Problem:**' (one sentence — the visible symptom), then '**Why 1:**' through '**Why 5:**' — each one diving one level deeper into causation. End with '**근본 원인 / Root cause:**' (the answer to Why 5), then '**Action items**' (markdown checkboxes, 3-5 items addressing the root cause AND intermediate causes — not just symptoms). Blameless tone.\n\nIncident:\n${text}`,
  feature_naming: (text) =>
    `Suggest 5 product feature name candidates for the capability described. Mix styles: 1) **Literal / clear** (says what it does), 2) **Action verb** (starts with a verb), 3) **Metaphor** (evokes an analogy), 4) **Compound** (two short words joined), 5) **Brandable** (made-up but pronounceable). For each: name + 1-sentence justification + 1 risk (what it might be confused with). Reply as markdown bullets formatted '- **Name** — why / *risk: …*'.\n\nCapability:\n${text}`,
  release_note_internal: (text) =>
    `Write an internal-only release note for the team based on the context. Markdown sections with bold labels: **What's shipping** (one sentence), **Impact** (who/what changes downstream), **Migration steps** (numbered, only if applicable), **Owners** (per-component bullets — 'Backend: …', 'Frontend: …', 'Ops: …'), **Rollback plan** (3 short steps), **What to monitor** (3 specific metrics/dashboards/log queries). Concise, no marketing language.\n\nRelease:\n${text}`,
  cv_bullet_impact: (text) =>
    `Rewrite the resume bullet below in 3 stronger, impact-driven variants. Each follows X-Y-Z formula: 'Accomplished [X], measured by [Y], by doing [Z].' Vary the angle: 1) **Metric-led** (lead with the number), 2) **Scope-led** (lead with the size / breadth), 3) **Story-led** (lead with the challenge). Reply as a markdown numbered list. After the 3 variants, add '**Verbs I'd avoid here:**' (2-3 bullets calling out weak verbs the original used).\n\nOriginal bullet:\n${text}`,
  journal_prompt_ko: (text) =>
    `Generate 7 Korean daily journaling prompts (저널링 질문) themed around the context below. Mix angles: 감정 (오늘 가장 강하게 느낀 감정은?), 감사 (작은 감사 하나), 성찰 (놓치고 있던 것), 인간관계 (오늘 영향받은 사람), 진전 (어제보다 나아진 0.1%), 도전 (불편하지만 시도해볼 한 가지), 마무리 (내일의 한 단어). Use 해요체. Reply as a markdown numbered list, each prompt 1-2 sentences. Add a brief opening line setting the tone.\n\nContext / theme:\n${text}`,
  translate_natural_ko: (text) =>
    `Translate the text below into natural, fluent Korean — sounding like it was originally written by a Korean speaker, not translated. Avoid 번역체 (직역, 어색한 어순, 직역식 'A의 B', '~을(를) 가지다'). Pick the register from context (해요체 vs 합쇼체) and stay consistent. Reply with two markdown sections: '**자연스러운 한국어**' (the translation alone) and '**번역체에서 바꾼 표현**' (2-3 bullets noting awkward literals you avoided, with the original on the left and natural version on the right).\n\nOriginal:\n${text}`,
  release_tweet_thread_ko: (text) =>
    `Write a 5-tweet Korean release announcement thread (한국어 릴리스 트윗 스레드) from the context. Each tweet under 280자, numbered '1/5'. Tweet 1: 후킹 hook + 핵심 임팩트. Tweets 2-3: 구체적 가치 / 사용 시나리오. Tweet 4: 실제 변화 (숫자 / before-after). Tweet 5: CTA + 링크 placeholder. 자연스러운 한국어 SNS 톤 (해요체), 이모지 0-1개 / tweet. Reply as markdown.\n\nRelease:\n${text}`,
  feedback_rewrite_constructive: (text) =>
    `Rewrite the sharp / negative feedback below using the SBI (Situation-Behavior-Impact) model so it stays direct but respectful and actionable. Markdown sections: '**Situation**' (1 sentence framing where/when), '**Behavior**' (1-2 sentences on the specific observable action — not personality), '**Impact**' (1-2 sentences on the concrete effect on the team / project / user), '**Suggested next step**' (1 sentence — what to try differently). Preserve the core concern; remove judgment language.\n\nOriginal feedback:\n${text}`,
  bullets_to_paragraph: (text) =>
    `Convert the bullet list below into 2-3 flowing prose paragraphs suitable for an executive brief or written memo. Use smooth connectives ('Meanwhile', 'As a result', 'In parallel'), vary sentence length, group related bullets into the same paragraph. Preserve every fact. Reply with the paragraphs only — no preamble, no bullet residue.\n\nBullets:\n${text}`,
  paragraph_to_bullets: (text) =>
    `Convert the long paragraph(s) below into a scannable, hierarchical bullet list. Markdown nested bullets, 2 levels deep max. Top-level bullets capture main ideas (under 12 words each), sub-bullets carry supporting details or examples (under 18 words each). Preserve every fact, drop redundancies. Reply with bullets only.\n\nParagraph:\n${text}`,
  code_comment_jsdoc: (text) =>
    `Add a JSDoc / TSDoc comment block above the function below. Include: short one-line summary, blank line, longer paragraph if needed, then '@param' for each parameter (with type + description), '@returns' (type + description), '@throws' (only if applicable), '@example' (single fenced code block with realistic call + expected output). Reply with the commented function in a fenced code block.\n\nFunction:\n${text}`,
  k8s_yaml_from_app: (text) =>
    `Write Kubernetes manifests for the application described. Produce a single fenced \`\`\`yaml block containing: 1) a Deployment (2 replicas, resource requests/limits, readiness + liveness probes on /healthz, non-root securityContext, env from a referenced Secret), 2) a Service (ClusterIP, sensible port), 3) a horizontal Pod autoscaler stub (min 2, max 10, CPU 70%). After the yaml, '**Notes**' (3 bullets — image tag pinning, namespace, where Secret should come from).\n\nApp:\n${text}`,
  dockerfile_multistage: (text) =>
    `Write a production-ready multi-stage Dockerfile for the stack described. Include: a build stage (with cached deps), a runtime stage (slim base, non-root user, healthcheck, minimal layers, no dev deps). Wrap in a fenced \`\`\`dockerfile block. After: '**Build & run**' (one fenced bash block with the docker build + docker run commands), then '**Watch outs**' (3 bullets — image size, cold-start, secrets handling).\n\nStack:\n${text}`,
  git_rebase_strategy: (text) =>
    `Given the branch situation below, recommend a git strategy. Markdown sections: **Recommendation** ('rebase' / 'merge' / 'squash' + 1-2 sentences justifying), **Why not the alternatives** (2 bullets), **Step-by-step commands** (numbered, in a fenced bash block), **Risks & rollback** (2 bullets — how to recover if something goes wrong). Specific to the described branch state, not generic.\n\nBranch state:\n${text}`,
  cors_config: (text) =>
    `Recommend a CORS configuration for the scenario below. Markdown sections: **Recommended config** (fenced code block — pick the right framework based on context: Express/Next.js/Nginx), **Why these values** (table | Setting | Value | Reason |, 4-6 rows covering Access-Control-Allow-Origin, Methods, Headers, Credentials, Max-Age, Expose-Headers), **Common mistakes to avoid** (2-3 bullets — e.g. '*' with credentials, missing preflight). Be specific to the scenario.\n\nScenario:\n${text}`,
  changelog_ko: (text) =>
    `Rewrite the changes below as a Korean user-facing changelog (한국어 변경 로그) in 합쇼체. Markdown sections with bold labels and emoji: **✨ 신규 기능**, **🛠 개선 사항**, **🐛 버그 수정**, **⚠️ 주의 / 호환성**. Each bullet under 110자, lead with what changed for the user (not how it was built). Skip empty sections.\n\n변경 사항:\n${text}`,
  scam_detect_ko: (text) =>
    `Scan the Korean message / text below for scam, phishing, or social-engineering signals. Markdown sections: **종합 점수** (0-100, higher = more risky), **탐지된 신호** (bullets — 각 신호명 + 이유 + 인용된 문구), **위험 패턴** (선택 — 긴급성 압박 / 권위 사칭 / 의심 링크 / 개인정보 요구 / 비정상 결제 요청 등), **권장 조치** (3 bullets — 사용자에게 줄 행동 지침). Use 해요체.\n\n메시지:\n${text}`,
  contract_clause_explain_ko: (text) =>
    `Explain the contract clause(s) below in Korean using 해요체, focusing on what they mean for the signer. Markdown sections: **이 조항의 핵심 의미** (한 문단 plain Korean), **나에게 어떤 영향** (3 bullets — 권리 / 의무 / 제약), **숨겨진 리스크** (2 bullets — 자주 놓치는 함정), **협상 시 체크포인트** (3 bullets — 무엇을 요구할지). 법률 용어는 풀어쓰고, 직역체 금지.\n\n조항:\n${text}`,
  study_cheatsheet: (text) =>
    `Build a single-page cheatsheet for the topic below. Markdown sections with bold labels: **핵심 정의 / Core terms** (5-8 bullets: '- 용어 — one-line def'), **공식·규칙 / Formulas & rules** (3-5 short fenced snippets or bullets), **자주 쓰는 예제 / Quick examples** (2 short snippets), **흔한 실수 / Gotchas** (3 bullets), **암기할 한 줄 / TL;DR** (one bold sentence). Compact, scannable, no fluff. Match input language for labels.\n\nTopic:\n${text}`,
  saas_onboarding_checklist: (text) =>
    `Design a 7-step SaaS user onboarding checklist for the product. Markdown numbered list, each step formatted '**Step N — Title** (X분): one-line goal • success signal'. Order roughly: 계정 생성 → 핵심 설정 → 첫 데이터 입력 → 핵심 기능 1개 체험 → aha-moment → 협업 / 공유 → 다음 단계 (구독 / 팀 초대). After the list, add '**Aha-moment 정의:**' line — the specific in-product event we should optimize for.\n\nProduct:\n${text}`,
  email_thank_customer_ko: (text) =>
    `Write a heartfelt Korean thank-you email to a customer based on the context. Use 해요체 (warmer than 합쇼체). 3 short paragraphs: 1) 구체적인 감사 인사 (그 고객의 특정 행동 — 구매 / 후기 / 소개 / 피드백 등을 짚어줌), 2) 그 행동이 우리에게 어떤 의미였는지 진솔하게, 3) 앞으로의 약속 + 부담 없는 mantenimiento 멘트. 제목 ('제목: …') 첫 줄. Reply with the email only.\n\nContext:\n${text}`,
  community_rules_ko: (text) =>
    `Draft 5 Korean community guidelines (커뮤니티 규칙) tailored to the space. Numbered list, each rule: '**N. 한 줄 원칙 (행동 지침형)**' on first line, then 1-sentence explanation in 해요체, then '**위반 시:**' bullet with the moderation action (경고 / 일시 정지 / 영구 정지). End with one bold '**우리가 지향하는 분위기:**' sentence summarizing the vibe.\n\n커뮤니티 맥락:\n${text}`,
  translate_formal_jp: (text) =>
    `Translate / rewrite the text below into formal Japanese business writing (ビジネス日本語 / 敬語). Use 「お世話になっております」 style openings if it's an email, 尊敬語 for the counterpart's actions, 謙譲語 for our actions, 「よろしくお願いいたします」 style closes. Reply with two markdown sections: '**フォーマル日本語**' (the translation alone) and '**敬語ノート**' (2-3 bullets noting 尊敬語/謙譲語 choices and any Japanese-specific framing changes from the original).\n\nOriginal:\n${text}`,
  dashboard_widgets_spec: (text) =>
    `Design 6 dashboard widgets for the dashboard purpose below. Reply as a markdown table with columns | # | Widget title | Metric / question answered | Visualization (number / line / bar / table / gauge / heatmap) | Filters | Refresh rate |. Pick widgets that together tell a coherent story about the goal — overview first, then breakdowns, then leading indicators. After the table, '**Empty state:**' one sentence on what shows when no data.\n\nDashboard purpose:\n${text}`,
  error_message_friendly: (text) =>
    `Convert the technical error / failure below into a friendly user-facing message. Markdown labels: **Title** (under 8 words, calm — no 'Oops!' or alarm), **Body** (1-2 sentences: what happened in user terms + what to try), **Primary CTA** (3-word button label), **Secondary CTA** (3-word button label, often 'Try again' or 'Contact support'), **Tech detail (collapsed)** (one-line ID / code the user can share with support). Avoid blaming the user.\n\nError:\n${text}`,
  translate_academic_ko: (text) =>
    `Translate the text below into academic Korean (학술 한국어) suitable for a peer-reviewed paper or thesis chapter. Use 합쇼체 with abundant 한자어 (분석한 결과 / 도출되었다 / 시사하는 바가 크다), passive constructions where natural, hedged claims (~로 보인다, ~로 추정된다, ~로 해석할 수 있다). Avoid 구어체 and emoji. Reply with two markdown sections: '**학술 한국어 번역**' (the translation alone) and '**용어 선택 노트**' (2-3 bullets on key terminology choices and register decisions).\n\nOriginal:\n${text}`,
  code_explain_line_by_line: (text) =>
    `Explain the code below line by line for a beginner. Reply with the original code in a fenced block, with each meaningful line annotated as a trailing comment ('// …' or '# …' per language). After the code, add '**Bigger picture**' (2-3 sentence summary of what the whole snippet accomplishes) and '**Vocabulary**' (3-5 bullets defining the language / framework concepts a beginner would hit here).\n\nCode:\n${text}`,
  sql_optimize_ko: (text) =>
    `Analyze the SQL query below and suggest optimizations. Reply in Korean using 해요체. Markdown: '**원본 쿼리 핵심 동작**' (한 문단), '**최적화 제안**' (3 bullets — 인덱스 / 조인 순서 / 서브쿼리 → CTE / EXPLAIN 분석 포인트 등 적용 가능한 것만), '**개선된 쿼리**' (fenced SQL block — Postgres dialect by default), '**예상 개선 효과**' (1-2 sentences with rough magnitude + monitoring tip).\n\n쿼리:\n${text}`,
  customer_call_script_ko: (text) =>
    `Draft a Korean inbound customer-support call script (한국어 인바운드 CS 콜) for the situation described. Use 해요체. Markdown sections: **인사 & 확인 (20초)** (인사 + 본인 확인 + 문제 청취 멘트), **공감 & 정리 (1분)** (감정 인정 + 문제 1줄 요약 + 정확성 확인), **해결 안내 (2-3분)** (해결안 1순위 + 대안 + 절차 안내 — 각 1-2문장), **마무리 (30초)** (요약 + 추가 도움 여부 확인 + 정중한 마무리 + 후속 안내). 어조: 차분, 책임감, 변명 X.\n\n상황:\n${text}`,
  marketing_email_segments: (text) =>
    `Write 3 segmented marketing emails for the offering below — one per audience. Markdown with three H2 sections: '## 신규 (가입 7일 이내)', '## 활성 (정기 사용 중)', '## 이탈 위험 (30일 미접속)'. Under each: '**제목:**' line + 4-5 sentence body tuned to that segment's mindset (신규: 첫 가치 발견 / 활성: 깊은 활용 팁 / 이탈위험: 컴백 인센티브 + 부담 없는 한 발). Korean, 해요체. Each ends with a single CTA line.\n\nOffering:\n${text}`,
  youtube_script_3min: (text) =>
    `Write a 3-minute YouTube script (~450 words) on the topic. Markdown sections with bold labels and rough timestamps: **Hook (0-5s)** — one provocative sentence that promises payoff, **Intro (5-15s)** — quick 'what you'll learn' + credibility line, **Beat 1 (15s-1m)**, **Beat 2 (1m-2m)**, **Beat 3 (2m-2:30)** — each beat a substantive point with 1 example, **CTA (2:30-3:00)** — recap + subscribe/follow line + tease next video. Write actual spoken lines, conversational, not bullet points.\n\nTopic:\n${text}`,
  twitter_bio_3_ko: (text) =>
    `Write 3 Korean Twitter/X profile bios (under 160자 each) based on the context. Vary the angle: 1) **진지한 전문가** (직책 + 분야 + 1줄 강점), 2) **장난기 있는** (자기비하 + 한 가지 진심 + 이모지 1-2개), 3) **흥미 유발** (역설적 한 줄 + 호기심 자극 + 링크 placeholder). Reply as markdown bullets with the angle label in bold prefix, e.g. '- **진지한 전문가:** …'.\n\nContext:\n${text}`,
  sql_window_function: (text) =>
    `Translate the natural-language analytics question below into a SQL query that uses window functions (ROW_NUMBER / RANK / LAG / LEAD / SUM OVER / NTILE 등 적합한 것). Reply with a fenced \`\`\`sql block of the query (Postgres dialect), then '**Why this window function:**' 1-2 sentences explaining the choice, then '**Alternative (non-window) approach:**' 1-2 sentences explaining how it could be done without window functions and the trade-off.\n\nQuestion:\n${text}`,
  release_rollback_plan: (text) =>
    `Draft a release rollback plan for the release described. Markdown sections with bold labels: **감지 / Detect** (3 specific signals + thresholds that should trigger rollback consideration), **결정 / Decide** (who decides + criteria for go vs no-go, with timer), **실행 / Execute** (numbered fenced bash/code steps to revert — feature flag flip, revert deploy, or DB rollback), **검증 / Verify** (3 checks to confirm the rollback restored the service), **공지 / Communicate** (internal + external messaging templates, 1-2 lines each), **사후 / Post** (1 line on triage + postmortem trigger).\n\nRelease:\n${text}`,
  api_pagination_design: (text) =>
    `Recommend a pagination design for the API / list endpoint described. Markdown sections: **Recommendation** (Offset / Cursor / Keyset + 1-2 sentence justification based on the data shape and access pattern), **Request format** (query params + types in a small table), **Response format** (fenced JSON example showing one page + the navigation field — 'next_cursor', 'has_more', etc.), **Trade-offs** (3 bullets — what we gain, what we give up), **Edge cases** (3 bullets — empty page, last page, concurrent inserts).\n\nEndpoint context:\n${text}`,
  diff_intent_explain: (text) =>
    `Read the git diff below and explain it. Markdown sections: **Intent** (1-2 sentences — what change the author was trying to make), **What actually changed** (3-5 bullets describing the concrete code changes), **Likely impact** (2 bullets — which behavior or users are affected), **Review focus** (3 bullets — what a reviewer should pay extra attention to: edge cases, perf, security, side effects). Stay specific to the diff.\n\nDiff:\n${text}`,
  feature_flag_rollout: (text) =>
    `Plan a staged feature-flag rollout for the change below. Markdown sections: **Flag name** (snake_case), **Target population** (one sentence + the segmentation key), **Stages** (table | Stage | % | Success criteria | Promote signal | Rollback signal |, 4 rows for 1% / 10% / 50% / 100%), **Kill switch trigger** (3 specific signals + thresholds), **Cleanup deadline** (date placeholder + the owner), **Observability** (2 bullets — what dashboard / metric to watch at each stage).\n\nFeature:\n${text}`,
  release_notes_detailed_ko: (text) =>
    `Write detailed Korean release notes (한국어 상세 릴리스 노트) using 합쇼체. Markdown sections with bold labels: **🎯 하이라이트** (1-3 bullets — 가장 중요한 변화), **✨ 신규 기능** (각 기능마다 H4 + 1-2문장 설명 + 사용법 1줄), **🛠 개선 사항** (bullet list), **🐛 버그 수정** (bullet list), **🔌 API / 호환성** (table | 영향 | 변경 전 | 변경 후 | 마이그레이션 |, 2-4 rows), **⚡ 성능** (수치 포함 bullet list), **⚠️ 주의 / Breaking** (있을 때만). Skip empty sections.\n\n릴리스 변경 사항:\n${text}`,
  translate_marketing_en: (text) =>
    `Translate the Korean (or other) text below into emotionally resonant marketing English. Lead with a benefit-driven hook, use sensory language, prefer short sentences. It's marketing — not literal translation; capture the intended *feeling*. Reply with two markdown sections: '**Marketing English**' (the rewrite — 2-4 short paragraphs) and '**Choices I made**' (2-3 bullets on emotional levers used, e.g. 'switched 시간 절약 to *focus where it counts*').\n\nOriginal:\n${text}`,
  devops_runbook: (text) =>
    `Draft a DevOps service runbook for the system below. Markdown sections with bold labels: **Service overview** (one paragraph: purpose, owner team, criticality tier), **Architecture** (3 bullets — main components + deps), **Deploy procedure** (numbered steps in a fenced bash block where useful), **Health checks** (table | Endpoint | Expected | Frequency |), **Alerts → response** (3 bullets — each alert paired with 2-3 first-response actions), **Common incidents** (table | Symptom | Likely cause | First mitigation |, 4-6 rows), **Escalation contacts** (bullet list with role placeholders), **Useful links** (5 placeholder bullets — dashboard, logs, repo, runbook for X, status page).\n\nService:\n${text}`,
  comment_intent_rewrite: (text) =>
    `Rewrite the comments in the code below so they explain WHY (intent, invariant, surprising constraint) rather than WHAT (which the code already shows). Remove comments that merely restate the code. Add one short comment where there's a non-obvious decision or gotcha that future readers would miss. Reply with the rewritten code in a fenced block, then a brief '**Notes**' section (2-3 bullets — what I removed, what I added, why).\n\nCode:\n${text}`,
  sales_discovery_questions_ko: (text) =>
    `Generate 8 Korean B2B sales discovery questions (한국어 디스커버리 질문) for the prospect described. Mix BANT (예산 / 권한 / 니즈 / 도입 시점) and MEDDIC (Metrics / Decision criteria / Decision process / Identify pain / Champion / Competition) angles. Use 해요체, open-ended ('어떤 식으로 ~하시는지 여쭤봐도 될까요?' style — not leading or yes/no). Reply as a markdown numbered list, each question 1-2 sentences. Add a brief '**진행 팁:**' line at the end (1 sentence).\n\nProspect / context:\n${text}`,
  db_er_diagram_mermaid: (text) =>
    `Produce a Mermaid \`erDiagram\` code block representing the domain described. Use clear ENTITY names in PascalCase, list 3-6 key attributes per entity (PK / FK marked), and show cardinality with proper Mermaid syntax (\`||--o{\`, \`}o--o{\`, etc.). Wrap in a fenced \`\`\`mermaid block. After the diagram, add '**Cardinality notes**' (2-3 bullets explaining the non-obvious relationship choices).\n\nDomain:\n${text}`,
  incident_comms_internal: (text) =>
    `Write 4 internal incident-communications messages for the incident described, suitable for #incidents Slack channel. Markdown with four bold sections each containing a short message: **T+0 (acknowledge)** — 2 sentences confirming we see it + first action, **T+15min (status)** — what we've learned + current theory + next check-in time, **T+45min (mitigation)** — what we tried + result + next attempt, **T+resolved (close)** — fix applied + impact summary + 'postmortem will follow within X days'. Each message in plain Korean 해요체.\n\nIncident:\n${text}`,
  copy_rewrite_3_angles: (text) =>
    `Rewrite the copy below 3 times using different psychological angles. Markdown with three bold sections: **Benefit-led** (open with the gain — what the reader gets), **Curiosity-led** (open with an intriguing gap or unexpected hook that pulls the reader in), **Loss-aversion** (open with what they're missing or losing right now). Each version preserves the core facts. Same length as the original, ±20%. Reply with the three versions only.\n\nOriginal copy:\n${text}`,
  translate_casual_en: (text) =>
    `Translate the text below into natural casual English — the way you'd write to a friend or in a Slack DM. Contractions OK ('we're', 'it's'), short sentences, conversational connectives ('so', 'anyway'), no corporate fluff. Preserve every fact. Reply with two markdown sections: '**Casual English**' (the translation alone) and '**Tone moves**' (2-3 bullets on what made it casual — e.g. 'replaced "in order to" with "to"').\n\nOriginal:\n${text}`,
  code_security_review: (text) =>
    `Review the code below for security issues using OWASP Top 10 as the lens. Reply as a markdown table with columns | Risk | OWASP category | Where (line/snippet) | Severity (L/M/H) | Suggested fix |. 3-6 rows. Cover injection, broken auth, sensitive data exposure, XXE, broken access control, security misconfig, XSS, deserialization, vulnerable deps, insufficient logging — whichever apply. After the table, '**Overall verdict:**' one bold sentence rating the snippet (Clean / Minor / Major / Critical).\n\nCode:\n${text}`,
  changelog_monthly_rollup: (text) =>
    `Roll up the month's changes below into a polished monthly changelog post. Markdown sections: **TL;DR** (3-4 bullets — the biggest moves), **✨ New features** (group by user-facing theme, 2-3 lines each), **🛠 Improvements** (concise bullet list), **🐛 Notable fixes** (3-5 bullets), **📊 By the numbers** (3-5 metric bullets — e.g. issues closed, contributors, deploys), **🔭 Next month** (1-2 sentence forward look). Skip empty sections.\n\nMonth's changes:\n${text}`,
  product_tour_script_ko: (text) =>
    `Write a 5-step Korean product tour script (제품 투어 가이드) for the product. Use 해요체. Markdown numbered list, each step formatted '**Step N — UI 위치 (앵커)**' on first line, then 1 sentence describing what to point out, then a 2-word CTA in italics for the coach-mark button. Order roughly: 가입 후 첫 화면 → 핵심 액션 발견 → 첫 결과물 만들기 → 협업 / 공유 → 다음 단계 / 도움 받기. Tour should leave the user with one concrete win.\n\nProduct:\n${text}`,
  email_intro_warm_ko: (text) =>
    `Draft a warm Korean introduction email (제3자가 소개해 준 상대에게 보내는 첫 메일). Use 합쇼체. Subject line first ('제목: …'), blank, then 4-5 short paragraphs: 1) 소개해 준 사람 언급 + 감사 한 줄, 2) 내가 누구이며 왜 연락드리는지 1-2 sentences, 3) 상대에게 도움이 될 만한 구체적 가치/지식 한 가지, 4) 부담 없는 다음 단계 (15분 통화 / 차 한잔 / 자료 공유 등), 5) 정중한 마무리 + 시그니처 placeholder. Reply with the email only.\n\nContext:\n${text}`,
  log_redact_pii: (text) =>
    `Scan the log snippet below for PII or other sensitive data that should be redacted. Reply as a markdown table with columns | Line / snippet | Data type (email / phone / 주민번호 / token / IP / name / address / other) | Risk (L/M/H) | Suggested mask pattern |. 3-6 rows. After the table, '**Recommended redaction strategy**' (3 bullets — where in the pipeline to redact, what masking format to use, what to leave for debuggability).\n\nLog:\n${text}`,
  career_narrative_ko: (text) =>
    `Read the career background below and write a 1-line Korean career narrative (한 줄 커리어 내러티브) + 3 strength bullets, suitable as a resume / LinkedIn hook. Use 합쇼체. Markdown: '**한 줄 narrative:**' (one sentence — '~을 ~해 온 ~' style, captures the through-line of the career), '**핵심 강점**' (3 bullets, each formatted '- **강점 이름** — 구체 증거 1줄'), '**다음 도전 방향**' (one sentence — 어디로 가고 싶은지).\n\nBackground:\n${text}`,
  api_error_codes: (text) =>
    `Design an error code catalog for the API described. Reply as a markdown table with columns | Code | HTTP status | Trigger condition | User-facing message | Suggested client action |. 8-12 rows covering: validation errors, auth (401/403 split), not found, conflict, rate limit, internal, dependency failures. Use a consistent code naming scheme (e.g. 'AUTH_TOKEN_EXPIRED', 'RATE_LIMIT_EXCEEDED'). After the table, '**Naming convention used:**' one bold sentence.\n\nAPI:\n${text}`,
  standup_summary_team_ko: (text) =>
    `Read the individual Korean standup notes below (multiple team members, separated by '---' or names) and produce a single team standup summary. Use 해요체. Markdown sections: **어제 완료** (3-5 bullets, attribute via '— 이름' suffix), **오늘 진행** (3-5 bullets, '— 이름' suffix), **블로커 / 도움 요청** (bullets, '— 이름' suffix; 'None' if empty), **눈에 띄는 진전** (1-2 sentences on biggest win or concerning slowdown). Dedupe, don't paraphrase facts.\n\nStandups:\n${text}`,
  regex_test_cases: (text) =>
    `Given the regular expression below, generate a test suite of 10 example strings — 5 that SHOULD match and 5 that should NOT match. Reply as a markdown table with columns | # | Input | Expect | Why |. Cover edge cases: empty string, boundary chars, mixed case, unicode, anchors, greediness traps. After the table, '**Coverage gaps**' (1-2 bullets on what's still untested — e.g. backtracking blowup, very long inputs).\n\nRegex:\n${text}`,
  error_msg_multilingual: (text) =>
    `Convert the technical error below into a friendly user-facing message in three languages. Markdown structure: three H2 sections '## English', '## 한국어', '## 日本語'. Under each: '**Title** / **제목** / **タイトル**' (under 8 words/words/語), '**Body** / **본문** / **本文**' (1-2 sentences), '**CTA** / **버튼** / **ボタン**' (3-word button label). Tone: calm, accountable, not blaming the user.\n\nError:\n${text}`,
  team_intro_ko: (text) =>
    `Write a Korean team-introduction post for a new member (신규 멤버 팀 소개 글). Use 해요체. Markdown sections with bold labels: **🙋 소개** (이름 + 직무 + 합류일 한 줄), **💼 어떤 일을 하나요?** (담당 업무 1-2문장), **🌱 어떤 경력이 있었나요?** (이전 경험 + 강점 1-2문장), **✨ TMI** (취미 / 좋아하는 것 / 재미있는 사실 — 2-3 bullets), **💬 환영 메시지 남기는 법** (한 줄 안내). Warm but professional.\n\n신규 멤버 정보:\n${text}`,
  strategy_1pager: (text) =>
    `Write a strategy 1-pager from the context below. Markdown sections with bold labels: **목표 / Goal** (one sentence — the outcome we want in 6-12 months), **현재 상황 / Where we are** (2-3 bullets — honest snapshot), **핵심 접근 / Strategic moves** (3 bullets — the bets we're making and why), **우선순위 / Priorities** (numbered 1-3 — what we do first, second, third), **측정 지표 / How we'll measure** (3 bullets — metric + target + frequency), **리스크 / Risks & mitigations** (3 bullets — risk → mitigation pair).\n\nContext:\n${text}`,
  translate_poetic_en: (text) =>
    `Translate the Korean (or other) text below into evocative English that preserves rhythm and imagery. Match cadence to the source — if it's spare, keep it spare; if it's lyrical, lean into rhythm and sound. Replace literal Korean structures with English idioms or sound patterns that carry the same feeling. Reply with two markdown sections: '**Poetic English**' (the translation alone) and '**What I traded**' (2-3 bullets noting what was preserved vs sacrificed — e.g. 'kept the staccato; lost the seasonal allusion in 단풍').\n\nOriginal:\n${text}`,
  api_deprecation_ko: (text) =>
    `Draft a Korean API deprecation announcement (한국어 API 일몰 공지) using 합쇼체. Markdown sections with bold labels: **무엇이 일몰되나요?** (deprecated 엔드포인트/필드 + 한 줄 이유), **언제부터?** (sunset 날짜 + 응답 변경 시점), **무엇으로 대체되나요?** (새 엔드포인트 + 마이그레이션 한 줄), **마이그레이션 가이드** (numbered 3-5 단계 + 코드 차이 fenced block), **지원 기간** (deprecated 상태 유지 기간 + 문의 채널). Subject line ('제목: …') 첫 줄.\n\nDeprecation context:\n${text}`,
  postmortem_detailed: (text) =>
    `Write a thorough English postmortem for the incident described, suitable for an SRE archive. Markdown sections with bold labels: **Summary** (3-4 sentences — what / when / impact / status), **Impact** (users affected, revenue, SLO burn, duration), **Timeline** (bulleted 'HH:MM UTC — event' lines, 8-15 entries from first signal to resolved), **Root cause** (one paragraph, technical), **Contributing factors** (3-5 bullets — tooling gaps, process gaps, monitoring blind spots), **What went well** (3 bullets), **What went poorly** (3 bullets), **Action items** (markdown checkbox table | Action | Owner | Due | Severity |). Blameless tone throughout.\n\nIncident:\n${text}`,
  customer_meeting_prep: (text) =>
    `Build a customer meeting prep doc from the context. Markdown sections with bold labels: **고객 / Customer** (one-line firmographic snapshot), **목표 / Our goal for this meeting** (1 sentence — the outcome we want), **그쪽 맥락 / What we know about them** (3-5 bullets — recent funding, product changes, public statements), **안건 / Agenda** (numbered 3-5 items with rough timing), **상대가 물을 만한 질문 / Likely questions from them** (3-5 bullets, each with a 1-line ready answer), **우리가 물을 질문 / Discovery questions to ask** (3-5 bullets), **다음 단계 / Asks & next step** (1 sentence — what we want them to commit to).\n\nContext:\n${text}`,
  changelog_twitter_thread: (text) =>
    `Turn the changelog below into a 5-tweet English release thread for Twitter/X. Each tweet under 270 chars, numbered '1/5'. Tweet 1: hook + the single biggest user-visible change. Tweets 2-3: two specific features with a concrete benefit each. Tweet 4: a small but delightful detail (the kind of thing power users love). Tweet 5: link placeholder + CTA + thanks. Conversational, 0-1 emoji per tweet. Reply as markdown.\n\nChangelog:\n${text}`,
  translate_poetic_jp: (text) =>
    `Translate the text below into evocative Japanese — preserve imagery and rhythm rather than translating word-for-word. Where the source has emotional or sensory weight, lean into 季語 / 余白 / 擬音語 to carry the same charge. Pick the right register (です・ます or 〜だ depending on the source mood). Reply with two markdown sections: '**詩的な日本語**' (the translation alone) and '**選択ノート**' (2-3 bullets on terminology choices and what shifted in register or imagery).\n\nOriginal:\n${text}`,
  bio_3_lengths: (text) =>
    `Write 3 versions of a professional bio for the subject below, at three different lengths. Markdown bold sections: **Short (under 50 chars)** — a single punchy line for a Twitter bio / email signature, **Medium (~150 chars)** — 1-2 sentences for a LinkedIn headline / event speaker card, **Long (~300 chars)** — 2-3 sentences for a website 'about' or conference site. Third person throughout. Keep the same factual core; vary only the depth and texture.\n\nSubject:\n${text}`,
  landing_hero_3_variant: (text) =>
    `Write 3 landing-page hero copy variants for the offering. Markdown with three bold sections — each contains: **Headline** (under 10 words), **Sub-head** (1 sentence, under 22 words), **Primary CTA** (3 words). Variants: 1) **Sharp & spare** — minimal words, strong verb, no fluff. 2) **Emotional / story-led** — opens on a feeling or moment the reader recognizes. 3) **Numbers-led** — opens with a concrete metric or proof point. Same core promise across all three.\n\nOffering:\n${text}`,
  release_blog_en: (text) =>
    `Rewrite the release notes below as a 400-500 word English release blog post. Personal voice (we / our team), narrative arc: a one-paragraph hook on the why, then 2-3 H2 sections each covering one shipped change with a concrete user benefit, a short paragraph on what we learned shipping it, and a closing CTA paragraph (try it / read docs / send feedback). Markdown. No marketing fluff.\n\nRelease notes:\n${text}`,
  translate_cs_formal_ko: (text) =>
    `Translate / rewrite the customer service message below into polite Korean (정중한 한국어 고객 응대). Use 합쇼체. Structure the body in 3 short paragraphs: 1) 진심 어린 사과 + 불편 인정 (변명 X), 2) 사실 정리 + 원인 한 줄, 3) 구체적 해결안 + 보상 (있으면) + 후속 안내. Subject line ('제목: …') 첫 줄, blank, body, then '○○○ 드림' placeholder. Reply with the message only.\n\nOriginal message:\n${text}`,
  api_readme_from_spec: (text) =>
    `Generate an API README.md from the spec below. Markdown sections: **Overview** (one paragraph — what the API does + base URL placeholder), **Installation** (fenced bash for npm / pip / curl as appropriate), **Authentication** (one paragraph + fenced example showing how to send the token), **Quickstart** (a single fenced call returning a 200 with example response), **Endpoints** (per-endpoint H3 with method + path + 1-line purpose), **Errors** (small table | Code | Meaning | Action |), **Rate limits**, **Support**. Keep it readable end-to-end.\n\nSpec:\n${text}`,
  sprint_goal_statement: (text) =>
    `Write a single-sentence sprint goal for the context below. Shape: 'By end of sprint, we will [verb] [outcome] so that [user benefit / business outcome].' Under 30 words, outcome-focused not output-focused, measurable. Then below the sentence add: '**Why this goal:**' (1 sentence on the bigger bet), '**Out of scope:**' (2-3 bullets — what we're explicitly NOT doing this sprint to protect focus).\n\nSprint context:\n${text}`,
  incident_tweet_public_ko: (text) =>
    `Write a calm, professional Korean incident-status tweet (한국어 장애 공지 트윗). 합쇼체, under 270자, no emoji. Structure across 2-3 short lines: 1) 영향받는 서비스/기능 + 인지 시각, 2) 현재 상태 (조사 중 / 조치 중 / 복구 진행) + 임시 우회 (있으면), 3) 다음 업데이트 시간 + 상태페이지 링크 placeholder. Reply with the tweet text only.\n\n장애 맥락:\n${text}`,
  podcast_intro_host_ko: (text) =>
    `Write a Korean podcast host opening intro (한국어 팟캐스트 호스트 오프닝) introducing today's guest. Use 해요체. Markdown structure: '**오프닝 (10초)**' — 인사 + 에피소드 번호 + 한 줄 hook, '**게스트 소개 (30-45초)**' — 게스트 이름 + 직책 + 2-3개 신뢰 신호 + 왜 오늘 이 분과 이 주제인지, '**오늘 다룰 것 (15초)**' — 3개 keyword 예고, '**전환 멘트**' — 게스트에게 첫 질문 던지는 자연스러운 다리 한 문장.\n\n게스트 + 주제:\n${text}`,
  code_rename_suggest: (text) =>
    `Review the code below and propose better names for unclear variables / functions / types. Reply as a markdown table with columns | Current name | Suggested | Why current is weak | Why suggested is better |. 3-6 rows. Focus on: misleading names, hungarian-style cruft, ambiguous abbreviations, overloaded meaning, names that lie about side effects. Skip purely stylistic preferences. End with one bold '**Highest impact rename:**' line picking the one rename that would help readers most.\n\nCode:\n${text}`,
  error_msg_empathic_ko: (text) =>
    `Convert the technical error below into a warm, empathic Korean user-facing message. Use 해요체. Markdown labels: **제목** (감정 인정 한 줄, 책망 X — '잠시 문제가 생겼어요' style), **본문** (2 sentences: 무슨 일이 일어났는지 일상어 + 사용자가 잃은 게 있다면 안심시키는 한 마디), **다음 행동 / Primary CTA** (3 단어 버튼 라벨, 'Try again' 같은 직역 X — '다시 시도' / '도움 받기'), **부가 / Secondary CTA** (3 단어), **기술 ID** (한 줄 — 사용자가 지원팀과 공유할 수 있는 코드).\n\n에러:\n${text}`,
  recruiter_reply_ko: (text) =>
    `Draft two short Korean reply messages to a recruiter / headhunter outreach. Use 합쇼체. Markdown with two H2 sections: '## 관심 있는 경우' — 4-5 sentences: 연락 감사 + 직무에 대한 솔직한 관심 + 현 상황 한 줄 (재직 중 / 이직 검토) + 다음 단계 제안 (간단한 통화 / JD 상세 요청) + 정중한 마무리. '## 관심 없는 경우' — 4 sentences: 연락 감사 + 정중한 거절 (이유는 짧게, 상세 사유 X) + 향후 다른 기회 열어두는 한 줄 + 정중한 마무리. Reply with both messages only.\n\nOutreach context:\n${text}`,
  translate_business_jp: (text) =>
    `Rewrite the text below as a polished Japanese business email (ビジネスメール). Use proper 敬語 throughout — 尊敬語 for the recipient's actions (なさる / ご覧になる), 謙譲語 for ours (いたします / 拝見いたします), 丁寧語 base (です・ます). Open with 「いつもお世話になっております。」-style line, close with 「何卒よろしくお願いいたします。」 + signature placeholder. Subject ('件名: …') first line, blank, body. Reply with the email only.\n\nContext:\n${text}`,
  landing_faq_ko: (text) =>
    `Write a 6-question Korean landing-page FAQ section for the offering below. Use 합쇼체. Cover these angles in order: 1) **가격 / 무료 사용**, 2) **보안 · 데이터**, 3) **환불 정책**, 4) **고객 지원 채널**, 5) **경쟁 제품 대비 차이**, 6) **도입 / 온보딩 난이도**. Each item: '**Q.** 한 줄 질문' / '**A.** 2-3문장 답변'. Direct, no fluff, no marketing platitudes.\n\nOffering:\n${text}`,
  pricing_objection_ko: (text) =>
    `Handle 4 common Korean B2B pricing objections for the offering. Use 해요체. Markdown bullets formatted '- **이의:** … / **응답:** …'. Cover: 1) '예산보다 비싸요', 2) '할인 가능하세요?', 3) '경쟁사가 더 저렴해요', 4) '내년 예산 잡고 다시 얘기해도 될까요?'. Each 응답: 1) 감정 인정 + 짧은 동의, 2) 가격이 아닌 가치 재정의 (구체 ROI / 시간 절약 / 위험 회피), 3) 부담 낮춘 다음 단계 제안. 따뜻하고 자신감 있게, 절대 굴종조 X.\n\nOffering:\n${text}`,
  competitor_positioning: (text) =>
    `Map the offering's position against named (or generic) competitors. Markdown sections: **The honest landscape** (2-3 sentences naming what category we're really in), **Where they win** (per-competitor mini-section — 1 H4 per competitor, 2 bullets each on their genuine strength), **Where we win** (3 bullets — capabilities or angles where our offering is clearly stronger), **Where it's a toss-up** (2 bullets — areas of overlap where the buyer's preference decides), **Positioning statement** (one sentence in the form 'For [segment] who [need], we are the [category] that [differentiator] — unlike [alternative].'). Be honest, not defensive.\n\nContext:\n${text}`,
  sql_explain_en: (text) =>
    `Explain the SQL query below in English, step by step. Markdown structure: '**One-line summary**' (what the query returns), '**Walkthrough**' (bullets in execution order: FROM / JOIN / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT — only the clauses used, each with 1 sentence on what it does AND why), '**Watch-outs**' (2-3 bullets on perf concerns, NULL handling, or unexpected edge cases this query may hit on real data).\n\nQuery:\n${text}`,
  contract_redline_ko: (text) =>
    `Read the Korean contract clause(s) below and propose redline edits in Korean only. For each problematic clause: markdown structure — '### 조항: [짧은 이름]', then '**현재:**' (원문 인용, > blockquote), '**제안:**' (수정안, > blockquote), '**근거:**' (1-2문장으로 왜 우리에게 더 유리해지는지). 3-5 clauses. 합쇼체 throughout. End with '**우선순위 제안:**' line ranking top 2 — 협상에서 양보 못 할 조항이 무엇인지.\n\n계약 조항:\n${text}`,
  sql_from_csv: (text) =>
    `Read the CSV data below (first line = headers, following lines = sample rows) and produce: 1) a fenced \`\`\`sql block with a CREATE TABLE statement (Postgres) — infer types conservatively (TEXT vs INT vs NUMERIC vs DATE vs BOOLEAN vs TIMESTAMP), pick a sensible PRIMARY KEY if obvious, add NOT NULL where the column has no empty values; 2) 3-5 INSERT statements seeded from the sample rows in the same fenced block; 3) '**Type inference notes**' (3 bullets explaining ambiguous columns and why you picked the type you did).\n\nCSV:\n${text}`,
  release_1_liner: (text) =>
    `Compress the release notes below into ONE single-sentence release line (under 110 chars) that works across Slack, email subject, in-app banner, and changelog header. Lead with the user benefit, name the new capability concretely, no jargon, no version number. After the line, '**Variants for tone**' — 3 short alt versions in markdown bullets labeled with '*Plain*', '*Punchy*', '*Friendly*'.\n\nRelease notes:\n${text}`,
  customer_story_narrative: (text) =>
    `Write a 3-minute customer story (250-350 words) from the context below. Three-beat arc with markdown bold labels: **Challenge** (the pain BEFORE, with one concrete moment that captures the frustration), **Solution** (how they adopted us — name one pivotal feature and one quick win in the first month), **Result** (the AFTER state, with at least one quantified metric and one human-feeling sentence). End with a single bold pull-quote line attributed to a plausible role.\n\nCustomer context:\n${text}`,
  api_error_codes_ko: (text) =>
    `Design a Korean-facing API error code catalog for the API described. Reply as a markdown table with columns | 코드 | HTTP | 발생 조건 | 사용자 메시지 (한국어, 해요체) | 클라이언트 처리 |. 8-12 rows covering 유효성 (400), 인증 (401), 권한 (403), 없음 (404), 충돌 (409), 레이트 (429), 서버 (500), 의존성 실패 (502/503/504). 코드 네이밍: 'AUTH_TOKEN_EXPIRED' / 'RATE_LIMIT_EXCEEDED' style — consistent SCREAMING_SNAKE. 사용자 메시지는 친절하고 비난조 X. End with '**네이밍 컨벤션:**' 한 줄.\n\nAPI:\n${text}`,
  translate_marketing_ko: (text) =>
    `Translate the text below into emotionally resonant Korean marketing copy (한국어 마케팅 카피). Use 해요체. Lead with a benefit-led hook in one short sentence, follow with 2-3 short sentences building the desire, then close on a clear single CTA line. 직역 금지 — 원문의 *느낌*을 살리되 한국어로 자연스럽게. Reply with two markdown sections: '**마케팅 한국어**' (the rewrite alone) and '**감정 레버**' (2-3 bullets explaining the emotional moves used).\n\n원본:\n${text}`,
  refactor_suggest_ko: (text) =>
    `Review the code below and propose 3 concrete refactorings in Korean (해요체). For each: '### N. 리팩토링 이름 (동사 + 대상)', then '**왜 필요해요?**' (1-2 sentences naming the smell — 중복 / 책임 과다 / 결합도 / 가독성 등), '**어떻게 바꿔요?**' (2-3 bullets — concrete code shape, 1-2 line snippet allowed), '**예상 효과**' (1 sentence — performance / readability / test surface 측면). End with '**우선순위:**' line ranking the top one.\n\n코드:\n${text}`,
  test_strategy_doc: (text) =>
    `Draft a test strategy doc for the feature described. Markdown sections with bold labels: **Feature scope** (one paragraph), **Test pyramid for this feature** (table | Layer | % effort | Examples |, 4 rows: unit / integration / e2e / manual exploratory), **Critical paths** (3-5 bullets — the user journeys that absolutely must work), **Edge cases & risk areas** (3-5 bullets), **Non-functional** (perf / a11y / security — bullets, only those that apply), **What we choose NOT to automate** (1-2 bullets + reason), **Owner & cadence** (one line — who runs which suite, how often).\n\nFeature:\n${text}`,
  incident_summary_exec_ko: (text) =>
    `Write a Korean executive-level incident summary (임원용 장애 요약) using 합쇼체. Exactly 3 sentences in the body — 1) 무엇이 일어났고 언제 복구되었는지, 2) 영향 범위 (사용자 수 / 매출 / SLA 영향 — 숫자 포함), 3) 근본 원인 한 줄. After the 3 sentences add bold '**다음 액션 (3가지):**' as a markdown bulleted list (3 short items with owner placeholder + 기한). Calm, factual tone — no apologies, no jargon.\n\n장애 맥락:\n${text}`,
  feedback_1_1_ko: (text) =>
    `Draft a Korean 1:1 feedback script (1:1 피드백 스크립트) for delivering balanced feedback to a direct report. Use 해요체. Markdown sections: **여는 말 (30초)** — 분위기 + 이 자리 목적 한 줄, **잘하고 있는 점 (2분)** — 구체적 행동 + 그 행동이 만든 영향 + 진심 한 줄, **개선했으면 하는 점 (3분)** — SBI 형식 (상황 / 행동 / 영향) + 그렇게 보는 이유 + 본인 시각 묻기, **함께 만드는 계획 (3분)** — 다음 30일 안에 시도해 볼 1가지 + 지원 약속, **여는 질문** — 매니저인 나에게 주는 피드백 요청 한 줄.\n\n맥락:\n${text}`,
  jira_epic_breakdown: (text) =>
    `Break the Epic below into 5-8 implementable Story-level Jira tickets. Markdown structure: '## Epic: [name]' with 1 sentence goal + 1 sentence success criteria. Then '### Stories' as a markdown table with columns | # | Title | Estimate (S/M/L) | Depends on | Acceptance criteria (one line) | Priority (P0-P2) |. End with '**Suggested order:**' bullet sequence respecting dependencies, and '**Out of scope for this epic:**' (2-3 bullets).\n\nEpic:\n${text}`,
  sales_discovery_summary_ko: (text) =>
    `Summarize the Korean sales discovery call notes below into a structured handoff. Use 해요체. Markdown sections: **고객사 / Account** (회사명 + 산업 + 규모 1줄), **참석자 / Attendees** (이름 + 직책 bullets), **현재 페인 / Pain points** (3-5 bullets — 가능하면 인용 한 줄 포함), **예산 / Budget** (한 줄 — confirmed / hinted / unknown), **도입 시점 / Timeline** (한 줄), **의사결정 구조 / Decision process** (2-3 bullets — economic buyer / influencer / blocker), **다음 단계 / Next step** (1 sentence — 누가 / 언제까지 / 무엇을). Dedupe, don't paraphrase.\n\n노트:\n${text}`,
  landing_cta_5_variant: (text) =>
    `Write 5 distinct CTA button copy variants for the offering / goal below. Each under 4 words. Markdown numbered list, each line formatted '**N. CTA 카피** — *angle*'. Vary the angle: 1) **Direct command** ('Start free'), 2) **Benefit-first** ('Save 5 hours'), 3) **Curiosity** ('See how it works'), 4) **Urgency** ('Try before Friday'), 5) **Low commitment** ('No card needed'). After the list, '**Top pick:**' one bold sentence recommending the strongest variant + 1-line reason.\n\nOffering / goal:\n${text}`,
  legal_clause_en: (text) =>
    `Read the natural-language intent below and draft a formal English legal clause. Use precise legal phrasing ('shall' for obligation, 'may' for permission, defined terms in **Bold**), full sentences, no ambiguity. Avoid ornament; aim for clarity a lawyer would not need to rewrite. Reply with two markdown sections: '**Clause**' (the drafted clause, 2-4 sentences) and '**Drafting notes**' (2-3 bullets — defined terms used, ambiguity I deliberately resolved, edge cases the clause covers).\n\nIntent:\n${text}`,
  customer_research_synthesis: (text) =>
    `Synthesize the customer interview notes / quotes below into a research readout. Markdown sections: **Sample** (one line — how many interviews + persona mix), **Top 3 themes** (each as '### Theme: [name]' with 2-3 sentence synthesis + 2 short verbatim quotes — '> "..." — Persona, role'), **Surprising signals** (2 bullets — quotes / behaviors that contradicted our prior assumptions), **Where we still have gaps** (2 bullets — what we did NOT learn enough about), **Recommended next steps** (3 bullets — concrete experiments, doc updates, or follow-up interviews).\n\nNotes:\n${text}`,
  sales_email_warm_ko: (text) =>
    `Write a warm Korean sales follow-up email to a prospect who has already shown interest. Use 해요체, warm but professional, no aggressive CTAs. Markdown sections: '**제목**' (1줄, 17자 이내, 호기심 자극 — 발신자 회사명 절대 포함하지 말 것), '**본문**' (4 short paragraphs: 1) 지난 대화/이벤트 reference 1줄, 2) 그동안 우리가 한 것 / 새로 알게 된 것 2-3줄, 3) 상대에게 도움 될 구체적 1가지 — 자료 / 데모 / 도입 사례 등, 4) low-friction CTA — '15분 짧게 통화 어떠세요?' 류 1줄), '**서명 톤 가이드**' (1줄 — 본인 시그니처에 어떤 톤을 더하면 좋을지).\n\n맥락 / 상대 정보:\n${text}`,
  changelog_html_ko: (text) =>
    `Convert the Korean release-note bullets below into a clean HTML changelog snippet ready to paste into a blog or release page. Output ONLY the HTML — no markdown fences. Structure: '<section class="changelog">', '<h2>vX.Y.Z — YYYY-MM-DD</h2>' (버전과 날짜는 입력에서 추출, 없으면 'vX.Y.Z' / 'YYYY-MM-DD' placeholder), then groups '<h3>✨ 새 기능</h3>', '<h3>🐞 버그 수정</h3>', '<h3>⚡ 개선</h3>' (해당 없는 그룹은 생략), each followed by '<ul><li>...</li></ul>'. Items keep emojis the user used and stay in 한국어. End with '<p class="thanks">기여해주신 분들: …</p>' only if contributors are mentioned.\n\n릴리스 노트 원문:\n${text}`,
  discovery_call_prep_ko: (text) =>
    `Prepare a Korean discovery call prep doc for the prospect below. Use 해요체. Markdown sections: '**고객사 1줄 요약**' (회사 / 산업 / 규모), '**리서치한 시그널**' (3 bullets — 최근 채용 공고 / 보도자료 / 제품 변화 등 우리가 미팅 전 확인한 단서), '**가설**' (2 bullets — 이 회사가 우리 제품을 필요로 할 만한 이유 가설 + 반증 가능성), '**열어볼 질문 5개**' (열린 질문, 각 1줄, 답변이 yes/no로 끝나지 않게), '**피해야 할 행동**' (2 bullets — 이 회사 컨텍스트에서 절대 하지 말아야 할 말 / 자료), '**다음 단계 정의**' (1줄 — 이 미팅이 잘됐다면 다음 약속을 무엇으로 잡고 싶은지).\n\n상대 / 맥락:\n${text}`,
  feature_request_response_ko: (text) =>
    `Draft a Korean response to a customer feature request. Use 해요체, empathic but honest about reality. The response should NEVER promise a date unless one is clearly given in the context. Markdown sections: '**받은 요청 요약**' (1줄 — 고객 입장에서 무엇이 필요한지), '**우리 답변**' (2-4 단락: 1) 요청 들어준 데 감사 + 우리가 정확히 이해했음을 confirm, 2) 현재 상태 — 이미 비슷한 기능 / 워크어라운드가 있다면 안내, 3) 결정 — 로드맵 검토 / 곧 작업 예정 / 지금은 우선순위 낮음 중 하나를 솔직하게, 4) 후속 — 우리가 다음에 어떤 액션을 할지 1줄), '**대안 / 워크어라운드**' (있으면 bullets — 없으면 섹션 생략).\n\n고객 요청:\n${text}`,
  translate_legal_en: (text) =>
    `Translate the legal text below into formal, contract-grade English. Preserve all defined terms (capitalize them as in the source if defined), all numbers, currencies, dates, and party names exactly. Use precise legal verbs ('shall' for obligation, 'may' for discretion, 'is entitled to' for right, 'must' only for absolute mandate). Do not soften or interpret ambiguity — mirror the source's ambiguity. Reply with two sections: '**Translation**' (the translated clause) and '**Translator notes**' (2-3 bullets — any defined term I introduced, any ambiguity I preserved deliberately, any source phrasing that has no clean legal-English equivalent and how I handled it).\n\nSource:\n${text}`,
  bug_repro_steps_ko: (text) =>
    `Turn the bug description below into a clean Korean reproduction report engineers can act on. Use 합쇼체. Markdown sections: '**요약**' (1줄, 50자 이내), '**환경**' (bullets — OS / 브라우저 / 앱 버전 / 사용자 역할 등 입력에 있는 것만, 없는 항목은 'unknown' 표기), '**재현 절차**' (numbered list, 각 단계 한 동작만, '클릭', '입력' 등 동사로 시작), '**기대 결과**' (1-2줄), '**실제 결과**' (1-2줄 — 가능하면 에러 메시지 인용), '**추가 단서**' (bullets — 스크린샷이 있다는 언급, 재현률, 우회법 — 없으면 섹션 생략).\n\n버그 설명 원문:\n${text}`,
  weekly_status_summary_ko: (text) =>
    `Compress the Korean weekly notes / standup logs below into a concise weekly status update for stakeholders. Use 해요체. Markdown sections: '**이번 주 핵심**' (3 bullets — 가장 중요한 것 3개, 가장 위에 임팩트 큰 것), '**완료**' (5 bullets max, 결과 중심으로 — '~ 출시', '~ 합의', '~ 머지'), '**진행 중**' (3 bullets — 다음 주에 끝낼 것), '**막힌 것 / 도움 필요**' (있으면 bullets, 누구의 도움이 필요한지 명시 — 없으면 '없음' 1줄), '**숫자**' (있으면 1-3줄 — 매출 / 가입 / 에러율 등 입력에서 추출 가능한 메트릭만).\n\n주간 노트:\n${text}`,
  ux_review_checklist: (text) =>
    `Review the UI / flow description below against a structured UX checklist. Use 해요체. Markdown sections per category (only include categories where the input gives us enough info to judge): '**가독성**' (대비 / 폰트 크기 / 본문 길이), '**정보 위계**' (제목 / CTA / 보조 정보 구분), '**상호작용**' (hit target / 피드백 / 로딩 상태 / disabled 처리), '**에러 / 빈 상태**' (메시지 톤 / 다음 액션 제시), '**접근성**' (alt 텍스트 / 키보드 / 색만으로 의미 전달하지 않기), '**카피**' (간결성 / 톤 일관성). Each category has 2-4 bullets, 각 bullet은 '✅' 통과 / '⚠️' 의심 / '❌' 명확한 문제 prefix. 마지막에 '**가장 먼저 고칠 3가지**' (numbered, 임팩트 ÷ 노력 순).\n\n검토 대상:\n${text}`,
  api_error_friendly_ko: (text) =>
    `Rewrite the raw API / server error messages below into user-friendly Korean error copy for the product UI. Use 해요체. For each error, output a markdown block: '### \`<원본 에러 코드 / 키>\`' followed by '**사용자에게 보일 메시지**' (1-2줄, 사용자 잘못으로 단정 짓지 말 것, 다음에 무엇을 시도할지 안내), '**보조 액션**' (1줄 — '다시 시도' / '로그인 다시' / '지원팀 문의' 등 버튼 라벨 후보), '**로깅용 영문**' (1줄 — 개발자가 로그에서 grep할 수 있는 짧은 영문). 사용자 메시지에는 절대 stack trace, internal id, 'null', '500' 같은 표현 노출하지 말 것.\n\n원본 에러들:\n${text}`,
  investor_followup_email_ko: (text) =>
    `Draft a Korean follow-up email to an investor after a first meeting. Use 해요체, warm but not desperate, signal momentum without exaggeration. Markdown sections: '**제목**' (1줄, 22자 이내, '[회사명] 미팅 follow-up' 류 — 호기심성 클릭베이트 금지), '**본문**' (4 단락: 1) 시간 내준 데 감사 + 미팅에서 가장 기억에 남은 1줄 reference, 2) 그쪽이 요청한 자료 / 질문에 대한 답 — 없으면 짧게 우리가 그 이후 진척시킨 것 1-2줄, 3) 한 줄 메트릭 / 마일스톤 1개 — 거짓 없이 가장 자신 있는 숫자 하나, 4) 다음 단계 제안 — '다음 라운드 일정에 맞춰 다시 업데이트 드려도 될까요?' 류 low-friction CTA), '**첨부 제안**' (1줄 — 무엇을 첨부하면 좋을지: deck / metrics one-pager / 고객 인터뷰 등).\n\n미팅 맥락:\n${text}`,
  competitor_teardown_ko: (text) =>
    `Write a Korean teardown of the competitor described below. Use 해요체, 객관적이고 추측은 추측이라고 표시. Markdown sections: '**한 줄 요약**' (1줄 — 그들이 누구이고 무엇을 파는지), '**타깃 고객**' (1-2줄, 우리와의 겹침/차이 포함), '**핵심 제안 가치**' (3 bullets — 그들이 가장 강하게 외치는 메시지), '**가격 / 패키지**' (확인 가능한 것만, 추측은 '(추정)' 표기), '**잘 하는 것**' (3 bullets — 솔직히 우리보다 나은 점), '**약한 곳**' (3 bullets — 우리가 파고들 만한 틈, 가능한 증거 1줄씩), '**우리 입장 시사점**' (2 bullets — 포지셔닝 / 메시지 변경 제안).\n\n경쟁사 정보:\n${text}`,
  user_persona_short_ko: (text) =>
    `Distill the user research / customer notes below into a single Korean user persona — short, sharp, usable in a deck. Use 해요체. Markdown sections: '### \`Persona name\`' (사람 이름 + 1줄 별명 — '예: 김지은 (바쁜 운영팀 리더)'), '**한 줄 요약**' (1줄, who + what they do), '**하루**' (3 bullets — 아침/낮/저녁 시점 행동), '**도구**' (2-3줄 — 평소 쓰는 SaaS / 앱), '**핵심 페인 3가지**' (numbered, 각 1줄 — 우리가 해결할 수 있는 것 위주), '**구매 권한**' (1줄 — 본인 결정 / 팀장 승인 / 임원 결정), '**도입을 막을 한 가지**' (1줄). 추가 metadata는 넣지 말기.\n\n리서치 노트:\n${text}`,
  sprint_demo_script_ko: (text) =>
    `Turn the sprint accomplishments below into a 5-minute Korean sprint demo script. Use 해요체. Markdown sections: '**오프닝 (30초)**' (1단락 — 이번 스프린트 한 줄 테마 + 데모에서 보여줄 것 3가지 예고), '**데모 흐름**' (3-5 항목, 각 항목: '### N. [기능명] — *목표*' + 1-2줄 데모 설명 + '**시연 액션:**' 1줄 (정확히 무엇을 클릭/입력) + '**왜 중요한가:**' 1줄), '**Q&A 대비**' (3 bullets — 예상 질문과 1줄 답변), '**클로징 (30초)**' (다음 스프린트 한 줄 예고 + 감사 인사). 데모 중 멘트는 따옴표로 감싸기.\n\n스프린트 성과:\n${text}`,
  blog_seo_outline_ko: (text) =>
    `Build an SEO-optimized Korean blog post outline for the topic below. Use 해요체. Markdown sections: '**타깃 키워드**' (메인 키워드 1개 + 롱테일 2-3개), '**검색 의도**' (1줄 — 정보형 / 비교형 / 구매형 / 트랜잭션형 + 1줄 근거), '**제안 제목**' (3개 변형, 각 30자 이내, 숫자 / 질문 / 약속 형태 다양화), '**메타 설명**' (1줄, 150자 이내), '**아웃라인**' (H2 4-6개, 각 H2 아래 3-4개 H3, 각 H3 옆에 ' — [bullet으로 1줄 코너]' 표기), '**내부 링크 후보**' (3 bullets — 어떤 종류의 기존 글로 링크하면 좋을지), '**CTA**' (1줄 — 글 끝에서 독자를 어디로 보낼지).\n\n주제:\n${text}`,
  translate_marketing_jp: (text) =>
    `Translate the marketing copy below into natural Japanese — 마케팅 카피로서 부자연스럽지 않게, 직역 금지. 사용 톤은 입력의 톤에 맞춤 (캐주얼 → カジュアル, 비즈니스 → 「です・ます」 정중체, 럭셔리 → 体言止め 적극 활용). 카피 라이팅 관습 존중 — 영어식 콜론(:)/줄바꿈 줄이기, 의미 단위로 끊기, 일본 시장에서 어색한 metaphor는 의역. Reply with two sections: '**翻訳**' (the translated copy, preserving line breaks where they aid rhythm) and '**翻訳ノート**' (3 bullets in Korean — 핵심 의역 결정 / 일본 시장 맥락 고려한 단어 선택 / 원문에서 살리지 못한 뉘앙스 1가지).\n\n원문:\n${text}`,
  press_release_short_ko: (text) =>
    `Write a short Korean press release (1 page max) for the announcement below. Use 합쇼체. Markdown sections: '**헤드라인**' (1줄, 35자 이내, who + what + 임팩트 1단어), '**부제목**' (1줄, 60자 이내, 헤드라인에 못 담은 핵심 보완), '**리드 단락**' (1단락 4줄 이내 — 6하원칙으로 핵심 압축, '오늘' / '오는 [날짜]' 시점 명확히), '**본문**' (2-3 단락 — 1) 배경과 의미, 2) 구체 수치 / 차별점, 3) 인용 1개 — '관계자 / 직책 / "..."' 형식), '**회사 소개**' (1단락 4줄 이내 — 끝에 보일러플레이트), '**문의처**' (담당자 / 이메일 형식, 입력에 없으면 placeholder).\n\n발표 내용:\n${text}`,
  incident_status_page_ko: (text) =>
    `Generate the Korean status page update copy for the incident described below. Use 합쇼체, 짧고 사실 위주, 추측 금지. 사용자 동작 영향만 적기 — 내부 디버깅 디테일 노출 금지. Markdown sections: '**상태 라벨**' (1단어 — Investigating / Identified / Monitoring / Resolved 중 입력 상황에 맞는 것 한국어로 — '조사 중' / '원인 파악' / '복구 모니터링' / '해결됨'), '**제목**' (1줄, 40자 이내 — 영향 받는 기능 + 영향 종류), '**현재 상황 (Investigating용)**' 또는 '**원인 (Identified용)**' 또는 '**복구 진행 (Monitoring용)**' 또는 '**최종 정리 (Resolved용)**' (1-2 단락, 사용자 입장에서 무엇이 어떻게 되었는지), '**다음 업데이트**' (1줄 — 'YYYY-MM-DD HH:MM KST에 다시 안내 드립니다' 또는 '복구 즉시 안내 드립니다').\n\n장애 상황:\n${text}`,
  qbr_deck_outline: (text) =>
    `Build a QBR (Quarterly Business Review) deck outline for the account / customer described below. Use 해요체 for narration notes. Markdown sections per slide: '### Slide N — [제목]' followed by '**Talking points**' (3-4 bullets in 해요체) and '**Visual suggestion**' (1 line — chart / screenshot / metric block). Required slides in order: 1) 표지 + agenda, 2) 지난 분기 핵심 성과 (3 KPI), 3) 사용 패턴 인사이트 (어떤 기능을 어떻게 쓰고 있는지), 4) 막힌 곳 / 해결한 케이스, 5) 우리 로드맵에서 이 고객이 받을 가치, 6) 이번 분기 함께 할 3가지 액션, 7) 갱신 / 확장 논의, 8) Q&A. 슬라이드 합 8장 고정.\n\n고객 / 계약 컨텍스트:\n${text}`,
  cs_followup_email_ko: (text) =>
    `Draft a Korean Customer Success follow-up email after a support ticket was resolved. Use 해요체, warm and humble — 'sorry for the trouble' tone without grovelling. Markdown sections: '**제목**' (1줄, 25자 이내 — '[제품명] 문의 후속 안내' 류), '**본문**' (3 단락: 1) 문의 주셔서 감사 + 우리가 무엇을 해결했는지 1줄, 2) 비슷한 일이 다시 안 일어나도록 우리가 한 / 할 일 1줄, 3) 도움 됐는지 1줄 질문 + 1-5 만족도 한 줄 부탁), '**P.S.**' (1줄 — 입력에 고객이 좋아할 만한 기능 / 변경이 있다면 작게 안내. 없으면 P.S. 자체 생략).\n\n티켓 맥락 / 해결 내용:\n${text}`,
  release_email_customer_ko: (text) =>
    `Write a Korean release announcement email to existing customers about the change described below. Use 해요체. Markdown sections: '**제목**' (1줄, 27자 이내 — 핵심 변경 1개를 명사형으로, 'New / 출시' 단어는 피하고 베네핏 위주), '**프리헤더**' (1줄, 90자 이내 — 제목이 못 담은 1가지 베네핏), '**본문**' (4 블록: 1) 한 줄 인사 + '이번 업데이트는 ...' 1줄, 2) 변경 핵심 3가지 (각 'h3 + 1줄 설명 + 1줄 "왜 좋아질지"'), 3) 알아둘 것 — 가격/플랜/마이그레이션 등 영향 있는 변경만, 4) CTA — '지금 새 기능 살펴보기' 류 1버튼 + 보조 링크 1개), '**서명**' (1줄 — '[제품팀 이름] 드림'). 이모지는 H3 앞에 하나씩만 허용.\n\n릴리스 내용:\n${text}`,
  okr_personal_quarterly_ko: (text) =>
    `Build a Korean personal quarterly OKR from the goals / themes below. Use 해요체. Markdown structure: '**테마 (Quarter focus)**' (1줄 — 이번 분기 단 하나의 큰 방향), then 3 'Objective' blocks: '### O1. [Objective 문장]' (영감 있는 정성 목표 1문장), '**Key Results**' (3 KR, 각 1줄, 반드시 측정 가능한 숫자 + 기한 + baseline 포함. baseline 모르면 '(baseline: 측정 필요)' 표기). KR 합 9개. 끝에 '**Health metrics**' (2 bullets — 이걸 추구하다 망가지면 안 되는 건강/관계/돈 같은 지표), '**Anti-goals**' (2 bullets — 이번 분기에 일부러 안 할 것).\n\n맥락:\n${text}`,
  stakeholder_update_email_ko: (text) =>
    `Draft a concise Korean stakeholder update email (보고 메일). Use 합쇼체. Markdown sections: '**제목**' (1줄, 30자 이내, '[프로젝트명] 진척 — YYYY-MM-DD' 류), '**한 줄 결론**' (1줄 — on track / at risk / blocked + 한 줄 근거), '**이번 주 진척**' (3 bullets — 결과 중심, 활동 나열 금지), '**다음 주 집중**' (3 bullets), '**위험과 의사결정 요청**' (있으면 numbered, 각 항목 'risk: 1줄 / 요청: 1줄 / 마감: 1줄'. 없으면 '없음' 1줄), '**숫자**' (있으면 1줄로 핵심 메트릭 3개 'KPI: a / b / c').\n\n진척 메모:\n${text}`,
  youtube_chapter_titles_ko: (text) =>
    `Generate Korean YouTube chapter timestamps for the video transcript / outline below. Output ONLY a markdown code block containing the chapters in YouTube-spec format: each line '\`MM:SS\`' or '\`HH:MM:SS\`' (영상이 1시간 이상이면) + ' ' + 챕터 제목 (16자 이내, 호기심 자극, 시청자 검색을 의식한 키워드 1개 포함). 첫 줄은 반드시 '00:00 인트로'. 총 5-10개. 챕터 사이 간격이 30초 미만이면 자동으로 합치고, 가장 긴 챕터가 5분 넘어가면 분할 제안을 코드 블록 아래 '**Note:**' 1줄로 추가.\n\n트랜스크립트 / 아웃라인:\n${text}`,
  translate_business_ko: (text) =>
    `Translate the source text below into formal Korean business prose. Use 합쇼체 throughout. 비즈니스 한국어 관습 존중 — 영어식 'I/We' 주어 생략하기, 외래어는 정착된 용어만 그대로 쓰고 아닌 것은 한국어로 풀기, 영어 약어는 첫 등장 시 '(약어: 풀이)' 표기. 직역 금지, 의미 보존. Reply with two sections: '**번역**' (the translated text, preserving paragraph breaks) and '**번역 노트**' (3 bullets — 외래어 처리 결정 / 의역한 핵심 / 원문에서 모호해서 우리가 어떤 의미로 잡았는지).\n\n원문:\n${text}`,
  team_charter_ko: (text) =>
    `Draft a Korean team charter for the team described below. Use 해요체. Markdown sections: '**미션**' (1문장 — 우리 팀이 존재하는 이유, 회사 수준 미션과 연결), '**비전 (1년)**' (1-2문장 — 1년 뒤 우리 팀이 어떻게 평가받고 싶은지), '**우리가 책임지는 것**' (3-5 bullets — 명사형, 구체적 결과물), '**우리가 책임지지 않는 것**' (2-3 bullets — 인접 팀과 헷갈리기 쉬운 영역 명시), '**운영 약속**' (4 bullets — 회의 리듬 / 의사결정 방식 / 충돌 다루는 법 / 정보 공유 채널), '**성공 지표**' (3 bullets — 1년 뒤 측정 가능한 지표), '**가치 (3개)**' (각 'h4: 가치명 — 1줄 정의 — "이렇게 행동하면 어긋남" 1줄 반례').\n\n팀 맥락:\n${text}`,
  negotiation_email_ko: (text) =>
    `Draft a Korean negotiation email — pricing, scope, terms — based on the situation below. Use 해요체, 단호하지만 관계를 지키는 톤, 양보와 비양보를 분명히 구분. Markdown sections: '**제목**' (1줄, 30자 이내, 협상 의도가 너무 노골적이지 않게), '**본문**' (4 단락: 1) 진척에 감사 + 협력 의지 1줄, 2) 우리 입장 명확히 — 무엇이 왜 우리에게 중요한지 2-3줄, 3) 우리가 줄 수 있는 것 / 절대 못 주는 것 명확히 — 'A는 가능합니다 / B는 어렵습니다' 형식, 4) 다음 단계 제안 — '월요일까지 답 주시면 화요일에 다시 정리해서 드리겠습니다' 류 마감 명시), '**서명 톤**' (1줄 — 협상 마지막 줄에 어떤 정서를 남기면 좋을지).\n\n상황:\n${text}`,
  perf_review_self_ko: (text) =>
    `Write a Korean self performance review from the accomplishments / reflections below. Use 합쇼체. Markdown sections: '**한 줄 요약**' (1줄 — 이번 기간 본인의 가장 큰 기여 1개), '**핵심 성과**' (3 bullets — 결과 + 임팩트 + 가능하면 메트릭. 'I' 주어 생략, 능동형 동사로), '**성장한 영역**' (2 bullets — 시작과 끝의 차이를 구체적 행동/스킬로), '**막혔던 것과 배움**' (2 bullets — 실수 / 막힌 일 + 거기서 얻은 lesson — 자기변호 금지), '**다음 기간 우선순위**' (3 bullets — 무엇을 / 왜 / 어떻게 측정), '**매니저에게 부탁**' (2 bullets — 내가 더 잘하려면 어떤 지원이 필요한지 구체적으로).\n\n자기 회고 노트:\n${text}`,
  saas_trial_email_d3_ko: (text) =>
    `Write a Korean SaaS trial Day-3 email targeting the persona described below. Use 해요체, 도움을 주려는 톤 — 영업 압박 금지. 트라이얼 시작 3일째 받는 메일이라 가정. Markdown sections: '**제목**' (1줄, 25자 이내 — '3일째예요, 잘 되고 계신가요?' 류 호기심 + 부담 없음), '**프리헤더**' (1줄, 80자 이내 — 메일에서 받을 1가지 가치), '**본문**' (4 단락: 1) 트라이얼 시작 감사 + 가볍게 안부 1줄, 2) 이 시점 트라이얼 사용자들이 가장 자주 막히는 1가지 + 1줄 해결 팁 — 페르소나 맞게 골라서, 3) '오늘 5분이면 끝나는 핵심 가치 체험' 1줄 가이드 + 링크, 4) '답장 주시면 제가 직접 도와드릴게요' 류 1줄 — 진심으로 사람 답장 가능한 톤), '**P.S.**' (1줄 — 트라이얼 기간 며칠 남았는지 친절히 환기).\n\n페르소나 / 제품 맥락:\n${text}`,
  open_source_readme_ko: (text) =>
    `Generate a Korean README for the open-source project described below. Output is markdown ready to paste into README.md. Sections in order: '# 프로젝트명' (h1, 입력에서 추출), 한 줄 tagline (이탤릭), '![뱃지 placeholder]()' 3개 한 줄 (build / license / version — placeholder 그대로), '## 무엇인가요' (2-3문장, 왜 만들어졌는지 포함), '## 빠른 시작' (코드 블록 1개 — 설치 + 가장 짧은 사용 예), '## 주요 기능' (3-5 bullets), '## 문서' (1줄 + 링크 placeholder), '## 기여' (1-2문장 + CONTRIBUTING.md 링크), '## 라이선스' (1줄 — 입력에 명시 없으면 'MIT' 가정). 영어 README가 아니라 한국어 README임을 의식해서 자연스러운 한국어로 — 'Getting Started' → '빠른 시작' 류.\n\n프로젝트 정보:\n${text}`,
  code_review_feedback_ko: (text) =>
    `Convert the raw code review notes below into structured Korean PR review feedback. Use 해요체, 단정 금지 — 제안 형태로. Markdown sections: '**전체 평가**' (1-2문장 — approve / request changes / comment + 한 줄 근거. 'LGTM' 같은 영문 약어는 한국어로 풀기), '**머지 전 꼭 고쳐주세요 (blocker)**' (numbered list, 각 항목 '\`파일:라인\` — 문제 1줄 — 제안 1줄'. 없으면 '없음' 1줄), '**고려해보면 좋아요 (nit / suggestion)**' (numbered list, 같은 포맷, 없으면 섹션 자체 생략), '**칭찬할 것**' (1-2 bullets — 코드의 깔끔함 / 결정의 합리성 등 진심으로 좋았던 것), '**확인 질문**' (있으면 1-2 bullets — '...는 의도하신 거 맞죠?' 류).\n\nPR 메모 / diff 설명:\n${text}`,
  intro_email_to_team_ko: (text) =>
    `Write a Korean 'welcome new teammate' intro email to the team. Use 해요체, 따뜻하지만 군더더기 없이. 발신자는 매니저 또는 팀장이라 가정. Markdown sections: '**제목**' (1줄, 25자 이내 — '[이름]님이 [팀명]에 합류합니다' 류), '**본문**' (4 단락: 1) '오늘부터 [이름]님이 [팀명]에 합류합니다' + 첫인사 1줄, 2) 핵심 배경 2-3줄 — 이전 회사 / 강점 / 우리 팀에서 맡을 역할, 3) 알면 좋은 사람적 디테일 1-2줄 — 취미 / 좋아하는 것 — 입력에 없으면 생략, 4) '환영 한 마디 [Slack 채널 / 점심 자리]에서 부탁드려요' 1줄 CTA), '**P.S.**' (1줄 — 새 멤버 첫 2주 동안 우리가 어떻게 도와야 할지 1가지 부탁).\n\n새 멤버 정보:\n${text}`,
  reorg_announcement_ko: (text) =>
    `Draft a Korean org-change announcement email for an internal reorg. Use 합쇼체. 솔직하고 명확하게 — 'we are excited to announce' 류 PR 톤 금지, 변경의 이유와 영향을 직시. Markdown sections: '**제목**' (1줄, 30자 이내, '[조직] 구성 변경 안내 — YYYY-MM-DD' 류), '**한 줄 결론**' (1줄 — 무엇이 어떻게 바뀌는지 핵심 1문장), '**왜 바뀌나요**' (1-2 단락 — 비즈니스 / 전략 / 운영상 솔직한 이유. '효율화' 같은 막연한 단어 금지), '**무엇이 바뀌나요**' (bullets — 팀 / 보고선 / 책임 영역 변화. before → after 형식), '**우리에게 어떤 영향이 있나요**' (2-3 bullets — 일하는 방식 / 회의 / 도구 변화), '**일정**' (1줄 — 발효일 + 전환 기간), '**질문은**' (1줄 — 누구에게 / 어디로).\n\n조직 변경 맥락:\n${text}`,
  thank_you_customer_review_ko: (text) =>
    `Write a Korean thank-you reply to a customer who left a positive review. Use 해요체, 진심 어린 톤 — 마케팅 카피 같은 가식 금지. Markdown sections: '**채널별 답변 (3개)**': '### 앱스토어 / 구글 플레이' (3-4줄, 리뷰에서 언급한 구체적 표현을 1개 인용하며 감사), '### 트위터 / X' (2줄 + 이모지 1개, 280자 이내), '### 블로그 / 미디엄 댓글' (4-5줄, 더 격식 있게 + 회사 입장에서 한마디 추가). 끝에 '**조심할 것**' 1줄 — 리뷰에 작은 불만이 섞여 있었다면 어디서 그것을 따로 다룰지 1줄. 영업 / 업셀 멘트 절대 금지.\n\n리뷰 내용:\n${text}`,
  raise_request_email_ko: (text) =>
    `Draft a Korean salary raise request email to a manager. Use 합쇼체, 단호하지만 협조적 — 위협 / 비교 / 감정 호소 금지, 데이터와 가치 중심. Markdown sections: '**제목**' (1줄, 20자 이내 — '연봉 조정 요청 드립니다' 류 직설적이되 격식), '**본문**' (4 단락: 1) 짧은 감사 + '아래 내용으로 연봉 조정을 요청드립니다' 1줄, 2) 입사 이후 임팩트 3가지 — 결과 + 가능하면 메트릭, '~을 했습니다' 능동형, 3) 요청 — 구체적 숫자 (현재 X → 요청 Y, 인상폭 Z%) + 근거 1줄 (시장가 / 업무 범위 확대 / 성과), 4) 다음 단계 — '시간 되실 때 30분 미팅 부탁드립니다' 1줄), '**첨부 제안**' (1줄 — 임팩트 1페이저 / 시장 데이터 자료 등 첨부할 것).\n\n본인 맥락:\n${text}`,
  monthly_growth_recap_ko: (text) =>
    `Generate a Korean monthly growth recap for internal sharing. Use 해요체. Markdown sections: '**한 달 한 줄**' (1줄 — 이번 달 핵심 변화), '**숫자**' (테이블 markdown — MoM 비교, 컬럼: '지표 | 이번 달 | 전월 | 변화'. 핵심 메트릭 4-6개), '**무엇이 움직였나**' (3 bullets — 가장 큰 변화 3개와 우리가 한 일 또는 외부 요인), '**무엇이 안 움직였나**' (2 bullets — 기대했는데 안 된 것 + 1줄 가설), '**다음 달 베팅 3가지**' (numbered — 무엇을 / 왜 / 어떻게 측정), '**도움 필요**' (있으면 1-2 bullets — 다른 팀에 요청할 것).\n\n월간 데이터 / 메모:\n${text}`,
  feature_kill_announcement_ko: (text) =>
    `Draft a Korean 'we are sunsetting a feature' announcement to existing users. Use 해요체, 솔직하고 미안한 톤 — 변명 금지, 그러나 사용자 입장의 다음 액션을 명확히. Markdown sections: '**제목**' (1줄, 30자 이내 — '[기능명] 종료 안내 — YYYY-MM-DD' 류), '**한 줄 요약**' (1줄 — 무엇이 언제 사라지는지), '**왜 종료하나요**' (1-2 단락 — 솔직한 이유, '비즈니스 우선순위', '낮은 사용량', '관리 비용' 등 진짜 이유), '**일정**' (bullets — 신규 사용 중단일 / 데이터 export 마감일 / 완전 종료일), '**여러분의 데이터는**' (1-2 단락 — 어떻게 export / 보존 / 자동 삭제될지), '**대안 제안**' (2-3 bullets — 우리 제품 안에서 / 외부 도구에서 어떻게 대체할 수 있는지), '**환불 정책**' (해당되는 플랜에 대해 1줄, 없으면 섹션 생략), '**감사**' (1줄 — 사용해주신 데 감사).\n\n종료 맥락:\n${text}`,
  outage_post_mortem_ko: (text) =>
    `Generate a public-facing Korean post-mortem report for an outage. Use 합쇼체, 사실 위주, 책임 회피 금지, 사용자 영향을 가장 먼저. Markdown sections: '**한 줄 요약**' (1줄 — 무엇이 / 언제 / 얼마 동안 / 누구에게 영향), '**타임라인 (KST)**' (테이블 — '시각 | 사건'. 감지 → 영향 시작 → 완화 → 복구 → 정상 확인까지), '**영향**' (bullets — 영향 받은 사용자 / 기능 / 데이터. 가능하면 수치), '**원인**' (1-2 단락 — 근본 원인 + 직접 원인을 분리해서), '**왜 더 빨리 못 잡았나**' (1 단락 — 모니터링 / 알림 / 절차의 빈틈), '**우리가 한 임시 조치**' (bullets), '**앞으로 할 변경**' (numbered — 항목 + 책임자 + 목표 일정), '**사과 한 줄**' (1줄 — 진심으로, '죄송합니다' 정확히 한 번).\n\n장애 사실 / 노트:\n${text}`,
  investor_pitch_one_liner: (text) =>
    `Distill the company / idea below into a one-line investor pitch — the sentence you say to a VC at a coffee meetup. Output exactly 3 variants of one line each, in this format: '**Variant N — [angle name]**: \\"...\\"' Each line under 22 words, uses the canonical template '[Company] is [category] for [audience] that [unique value]' but rephrased so it doesn't sound like a template. Vary the angle across 1) **Problem-led** (lead with the pain), 2) **Outcome-led** (lead with the dream result), 3) **Wedge-led** (lead with the surprising entry point). After the 3 variants, add '**Top pick:**' 1 bold sentence with which variant to use in a cold email vs in-person + 1-line reason.\n\nCompany / idea:\n${text}`,
  trade_show_booth_copy_ko: (text) =>
    `Write Korean trade-show booth copy for the offering below. 부스 방문자가 3초 안에 멈춰서고, 30초 안에 '한 번 들어볼까' 결심하게 만드는 것이 목표. Use 해요체. Markdown sections: '**대형 헤드라인 (벽면)**' (1줄, 8자 이내, 멀리서도 읽힘 — 동사형 또는 짧은 약속), '**서브 헤드라인**' (1줄, 18자 이내, 헤드라인 보완), '**3초 설명 (한 줄)**' (입체 글자 또는 패널용, 18자 이내, 누구를 위한 무엇인지), '**30초 설명 (스탠드 옆 작은 패널)**' (3-4줄, 핵심 베네핏 3개 bullet 형식), '**부스 직원이 첫마디로 던질 질문 3개**' (열린 질문, '이번 행사에서 가장 보고 싶으셨던 거 있어요?' 류), '**굿즈 / 리드 캡처 제안**' (1-2 bullets — 어떤 미끼로 명함 받을지).\n\n제품 / 행사 맥락:\n${text}`,
  linkedin_post_thought_leader_ko: (text) =>
    `Write a Korean LinkedIn 'thought leader' style post based on the insight below. Use 해요체. 자랑 / 험블 브래그 / 클릭베이트 톤 절대 금지. Markdown structure: '**HOOK (첫 2줄)**' (1-2줄, 끝까지 읽고 싶게 만드는 질문 또는 의외의 주장. '...라고 생각했는데, 틀렸어요.' 류), '**본문**' (200-300자, 짧은 문단 3-4개, 한 문단에 한 생각. 본인 경험에서 시작 → 깨달은 것 → 일반화한 시사점), '**마무리 한 줄**' (1줄 — 작은 질문으로 댓글 유도, '여러분은 어떠세요?' 보다 더 구체적인 질문), '**해시태그**' (3-5개, 한국어 / 영어 섞어도 됨, 너무 일반적인 것 (#성공 #동기부여) 피하기). 글 전체 한국어 LinkedIn 600자 이내.\n\n인사이트 원천:\n${text}`,
  translate_casual_ko: (text) =>
    `Translate the source text below into casual Korean (반말). 친구한테 카톡 보내는 톤 — 짧은 문장, 자연스러운 추임새, 영어 외래어는 한국에서 실제로 쓰는 것만 그대로. 직역 금지, 의역 우선, 원문이 격식 차린 거면 의도적으로 풀어서 친근하게. Reply with two sections: '**번역**' (the casual Korean text, preserving paragraph breaks) and '**번역 노트**' (3 bullets — 어떤 영어 표현을 어떻게 풀었는지 1가지 / 의역해서 살린 뉘앙스 1가지 / 반말이 어색해질 수 있는 부분과 그 처리).\n\n원문:\n${text}`,
  haiku_ko: (text) =>
    `Compose a Korean haiku inspired by the theme / scene below. 일본 하이쿠 5-7-5 음절 구조를 한국어 자수(글자 수)로 근사 — 5자 / 7자 / 5자. 계절감(계어)이 입력에 있으면 살리고, 없으면 시간성을 띠는 단어 1개 (밤, 새벽, 가을 등) 자연스럽게 포함. 추상명사 나열 금지 — 구체적 사물 / 동작 / 감각. Reply with three sections: '**하이쿠 (5-7-5)**' (3줄, 각 줄 글자 수를 마지막에 '(5)', '(7)', '(5)'로 표시), '**한 줄 영문 번역**' (1줄, 5-7-5 강제 안 함, 의미 전달 위주), '**짓기 노트**' (2 bullets — 계어 / 감각 선택 1줄, 5-7-5에 맞추느라 양보한 표현 1줄).\n\n테마:\n${text}`,
  sql_join_explain: (text) =>
    `Explain the SQL query below — specifically focusing on its JOINs — for a junior engineer. Use 해요체. Markdown sections: '**한 줄 요약**' (1줄 — 이 쿼리가 결과적으로 무엇을 가져오는지), '**테이블 역할**' (bullets — 등장하는 테이블마다 1줄로 '이 테이블은 _를 담고 있어요'), '**JOIN 흐름**' (numbered — 각 JOIN을 차례로 '\`A JOIN B ON ...\` — A의 어느 컬럼이 B의 어느 컬럼과 어떻게 매칭되는지, 그 결과 어떤 row 모양이 만들어지는지 1-2줄'), '**조심할 것**' (2-3 bullets — INNER vs LEFT의 영향, 카디널리티 폭발 위험, 인덱스가 없으면 느려질 컬럼), '**같은 의도의 더 깔끔한 표현**' (있으면 1개 — 더 간단한 쿼리 또는 CTE 분리 제안, 없으면 섹션 생략).\n\nSQL:\n${text}`,
  yaml_to_table: (text) =>
    `Convert the YAML below into one or more markdown tables. Reply with: 1) '**Tables**' — each top-level YAML mapping or sequence becomes its own markdown table. Header row should be sensible column names derived from the keys; if the YAML has uneven keys, fill missing cells with '—'. For nested values, flatten one level with dot notation ('owner.email'); deeper than that, keep the raw YAML in a code block cell. 2) '**Skipped / notes**' (bullets) — anything that couldn't cleanly fit a table (deeply nested, anchors/aliases, comments worth preserving). Use Korean (해요체) for any prose notes; column names and values stay as-is.\n\nYAML:\n${text}`,
  investor_metrics_one_pager_ko: (text) =>
    `Build a Korean investor metrics one-pager from the data below. Use 합쇼체. 한 페이지 안에 끝나는 분량 — 길지 않게. Markdown sections: '**한 줄 회사 정의**' (1줄 — 누가 / 무엇을 / 누구에게), '**핵심 메트릭 (3개)**' (테이블 — 'KPI | 현재 | 전월 | YoY'. 가장 중요한 3개만, ARR / MAU / Retention 류), '**성장 차트 한 줄 묘사**' (1줄 — '지난 6개월 ARR이 매월 X% 성장' 류, 그래프 대신 글로), '**고객 사례 한 줄**' (1줄 — 대표 고객 1곳 + 임팩트 수치), '**팀**' (1줄 — 인원 + 핵심 인사 1명), '**런웨이**' (1줄 — 'X개월 (Y월 기준)' — 자금소진율 가정 명시), '**다음 라운드 신호**' (1줄 — 우리가 라운드 준비 중인지 / 단지 대화 중인지 솔직히).\n\n데이터:\n${text}`,
  tldr_3_layers: (text) =>
    `Produce a 3-layered Korean TLDR of the text below — same content, three depths. Use 해요체. Markdown sections: '**👔 임원용 (1줄)**' (1줄, 핵심 결정 / 결론만 — 행동 단서 1개 포함), '**📐 PM / 매니저용 (3 bullets)**' (3 bullets — what / why / what next, 결정에 필요한 트레이드오프 1줄 포함), '**🛠 엔지니어용 (4-6 bullets)**' (구체적 변경 영향 / 기술 선택 / 마이그레이션 단서 / 위험 요소까지 — 코드 / 시스템 명사 그대로 노출). 세 layer가 같은 내용을 다른 해상도로 압축한다는 사실이 명확해야 함 — 임원용에 안 나온 결정이 PM용에 나오면 안 됨, 반대도 마찬가지.\n\n원문:\n${text}`,
  ad_copy_3_languages: (text) =>
    `Write an ad copy variant in 3 languages (Korean / English / Japanese) for the offering below. Each language: 1개 headline (each language's own convention — 한국어 18자 이내, English under 8 words, 日本語 20자 이내) + 1줄 본문 (각 언어 자연스러운 광고 카피, 60자 이내) + 1 CTA (버튼 라벨, 5자 / 3 words / 6자 이내). 직역 금지 — 같은 메시지를 각 시장의 광고 관습에 맞게 재해석. Reply with three markdown sections: '### 🇰🇷 한국어', '### 🇺🇸 English', '### 🇯🇵 日本語' — each containing 'Headline:', '본문 / Body / 本文:', 'CTA:' lines. 끝에 '**Adaptation notes**' (2 bullets — 시장별로 의식적으로 다르게 한 것).\n\nOffering:\n${text}`,
  decision_doc_one_pager_ko: (text) =>
    `Generate a Korean one-page decision document for the choice described below. Use 합쇼체. Markdown sections: '**결정**' (1줄 — '우리는 X를 한다' — 명사형이 아니라 동사형), '**결정자 / 결정일**' (1줄 — 'Decider: ... / Date: YYYY-MM-DD'), '**컨텍스트**' (3-4줄 — 이 결정이 필요해진 배경, 모르는 사람도 이해할 수 있게), '**고려한 옵션**' (테이블 — '옵션 | 장점 | 단점 | 리스크'. 3개 옵션 권장), '**선택 이유**' (2-3줄 — 위 옵션 중 왜 이것을 골랐는지, 다른 옵션을 버린 한 줄 이유 포함), '**예상 영향**' (3 bullets — 사용자 / 팀 / 비즈니스 각 1개), '**리뷰 시점**' (1줄 — '이 결정을 다시 평가할 트리거 또는 날짜').\n\n결정 컨텍스트:\n${text}`,
  founder_update_email_ko: (text) =>
    `Write a Korean monthly founder update email to investors / advisors / mentors. Use 합쇼체. 솔직하고 짧게 — 5분 이내 읽힐 것. Markdown sections: '**제목**' (1줄, 25자 이내 — '[회사명] 업데이트 — YYYY-MM' 류), '**한 줄 분위기**' (1줄 — 이번 달 솔직한 한 단어 + 1줄 — '아쉬웠다 / 좋았다 / 분주했다' 류), '**숫자 (3개)**' (bullets — MoM 변화 포함, 3개 메트릭만), '**잘 된 것 3가지**' (numbered — 결과 + 1줄 임팩트), '**막힌 것 / 배운 것 3가지**' (numbered — 솔직히, 변명 금지), '**도움 요청 (Asks)**' (numbered — 구체적으로 누구를 / 무엇을. 'X 산업 CFO 소개' 류), '**다음 달 베팅**' (2-3 bullets — 이번 달에 우리가 집중할 것).\n\n이번 달 데이터 / 메모:\n${text}`,
  brand_voice_audit_ko: (text) =>
    `Audit the brand copy sample below against a desired voice, in Korean. Use 해요체. Markdown sections: '**현재 톤 한 줄 진단**' (1줄 — 듣고 느낀 톤을 형용사 3개로), '**의도한 톤 vs 실제 톤**' (테이블 — '차원 | 의도 | 실제 | 격차'. 차원: 격식 / 따뜻함 / 자신감 / 유머. 각 row 1-5 척도), '**일관성 깨진 구간**' (bullets — 인용 한 줄씩 + 왜 톤이 어긋나는지 1줄), '**잘 살린 구간**' (1-2 bullets — 인용 + 왜 좋은지), '**리라이트 예시 3개**' (각 'before:' 1줄 + 'after:' 1줄 + '이유:' 1줄 — 톤 보정 의도 보여주기), '**다음 액션**' (3 bullets — 스타일 가이드에 추가할 룰).\n\n샘플 카피 + 의도한 톤:\n${text}`,
  scrum_standup_summary_ko: (text) =>
    `Compress the raw Korean standup notes (multiple people's updates) into a clean team standup summary. Use 해요체. Markdown sections: '**Yesterday**' (각 사람: '- @[이름] — 어제 한 일 1줄'), '**Today**' (같은 형식 — 오늘 할 일 1줄), '**Blockers (있는 사람만)**' (각 사람: '- @[이름] — 막힌 것 1줄 / 필요한 도움 1줄 / 도와줄 사람 후보 1명'), '**팀 차원 한 줄**' (1줄 — 오늘 팀이 가장 중요하게 봐야 할 1가지), '**자동 follow-up**' (없으면 생략, 있으면 1-2 bullets — '@이름 @이름 — 미팅 15분 잡기' 류). 사람 이름은 입력에 나온 것 그대로 유지, 가짜 이름 만들지 말기.\n\nStandup 원본 노트:\n${text}`,
  kickoff_meeting_agenda_ko: (text) =>
    `Build a Korean kickoff meeting agenda for the project described below. 60-minute slot 가정, 시간 배분 명시. Use 해요체. Markdown sections: '**프로젝트 한 줄**' (1줄 — 무엇을 / 누구를 위해 / 언제까지), '**미팅 목표 3가지**' (numbered — 이 60분이 끝나면 무엇이 명확해져야 하는지), '**참석자**' (bullets — 이름 / 역할 / 이 미팅에서의 책임. 입력에 없으면 placeholder), '**아젠다 (테이블)**' ('시간 | 항목 | 진행자 | 산출물' 컬럼. 5분 인트로 / 10분 컨텍스트 / 15분 스코프 / 15분 리스크 / 10분 다음 단계 / 5분 클로징 기본 골격, 프로젝트에 맞춰 조정), '**미팅 전 미리 읽을 것**' (2-3 bullets), '**Decisions to land today**' (3 bullets — 이 미팅이 끝날 때 결정돼야 하는 것들), '**다음 액션 템플릿**' (1줄 — 미팅 후 24시간 안에 누가 무엇을 공유할지).\n\n프로젝트 맥락:\n${text}`,
  podcast_show_notes_ko: (text) =>
    `Turn the podcast transcript / outline below into Korean show notes ready for the episode page. Use 해요체. Markdown sections: '**에피소드 제목**' (1줄, 30자 이내, 게스트 1줄 소개 + 호기심 한 줄. '#NN — ...' 형식), '**한 줄 요약**' (1줄 — 이 에피소드를 듣고 무엇을 얻을지), '**게스트**' (1-2 단락 — 누구이고 왜 이 주제로 모셨는지 + 링크 자리 표시 (트위터 / 회사 등)), '**타임스탬프 챕터**' (코드 블록 안에 'MM:SS 챕터명' 형식, 5-8개), '**언급된 것들**' (bullets — 책 / 도구 / 사람 / 기사. 각 1줄 + 가능한 링크 placeholder), '**3개의 핵심 인용**' (numbered — '> "..." (MM:SS)' 형식), '**리스너 액션**' (1-2 bullets — 이 에피소드를 듣고 시도해볼 한 가지).\n\n트랜스크립트:\n${text}`,
  translate_korean_dialect_seoul: (text) =>
    `Take the Korean text below — which may be in dialect (사투리), spoken style, or informal mix — and rewrite it in standard Seoul Korean (서울 표준어). Preserve the speaker's intent and emotional register. 격식 수준은 원문에 맞춤 — 원문이 반말이면 반말로, 존댓말이면 존댓말로. 사투리 표현은 표준어로 직접 매핑하되, 표준어에 없는 정서는 1줄로 노트 처리. Reply with two sections: '**표준어 변환**' (the rewritten text, paragraph breaks preserved) and '**변환 노트**' (3 bullets — 가장 큰 사투리 표현 1-2개와 표준어 대체 / 톤이 약해진 부분 1가지 / 표준어로 바꿀 수 없어 의역한 표현 1가지).\n\n원문:\n${text}`,
  user_onboarding_video_script_ko: (text) =>
    `Write a Korean 90-second user onboarding video script for the product described below. Use 해요체, 화자 한 명, 친근하고 빠른 페이스. Markdown sections per scene: '### Scene N (MM:SS-MM:SS)' followed by '**On screen**' (1-2줄 — 화면에서 무엇이 보일지) and '**Voiceover**' (1-2 문장 — 실제 멘트, 따옴표 안에). 권장 구성: Scene 1 (0:00-0:10) Hook — 사용자 페인 1줄, Scene 2 (0:10-0:25) 제품 한 줄 약속, Scene 3 (0:25-0:55) 핵심 가치 3가지를 빠르게 데모, Scene 4 (0:55-1:20) '오늘 5분이면 직접 해볼 수 있어요' 1가지 액션 안내, Scene 5 (1:20-1:30) 클로징 + CTA. 끝에 '**Voiceover 톤 가이드**' 1줄.\n\n제품 / 페르소나 맥락:\n${text}`,
  social_media_calendar_week_ko: (text) =>
    `Build a 7-day Korean social media content calendar for the brand / theme below. Use 해요체. Output a markdown table with columns: '요일 | 채널 | 포맷 | 한 줄 컨셉 | 카피 시작 | CTA'. 채널은 트위터/X, LinkedIn, Instagram, Threads 중에서 브랜드에 맞게 골라 매일 1-2개. 포맷은 텍스트, 이미지, 짧은 영상, 캐러셀, 인용 카드 등 다양화. 같은 메시지를 채널별로 다르게 표현. 1주일 안에 너무 많은 CTA(가입/구매)는 피하고 가벼운 참여 CTA(질문/좋아요/저장)를 섞기. 테이블 아래 '**리듬 노트**' (3 bullets — 1) 이 주 한 가지 큰 테마, 2) 어떤 요일이 가장 중요한 슬롯인지, 3) 다음 주에 시도할 실험 1개).\n\n브랜드 / 이번 주 테마:\n${text}`,
  pricing_change_announcement_ko: (text) =>
    `Draft a Korean pricing change announcement to existing customers. Use 합쇼체. 솔직하고 명확하게 — '가치 향상' 같은 막연한 단어 금지, 무엇이 어떻게 변하는지 정확히. Markdown sections: '**제목**' (1줄, 28자 이내, '[제품명] 요금 변경 안내 — YYYY-MM-DD' 류), '**핵심 1줄**' (1줄 — 누구에게 / 언제부터 / 얼마 / 어떤 방향으로 변경), '**왜 바꾸나요**' (1-2 단락 — 솔직한 이유: 비용 / 기능 추가 / 시장 정렬 등), '**기존 고객에게 영향**' (테이블 — '현재 플랜 | 이전 가격 | 새 가격 | 변경 시점 | grandfathered 여부'), '**우리가 한 것 / 할 것**' (3 bullets — 가격 인상을 완화하기 위해 우리가 한 노력: 새 기능 / 마이그레이션 가이드 / 할인 옵션), '**해약 / 환불 정책**' (1-2줄), '**문의처**' (1줄).\n\n가격 변경 맥락:\n${text}`,
  investor_anti_pitch_ko: (text) =>
    `Write a Korean 'anti-pitch' — an honest investor-facing memo about the things that could kill the company / why a reasonable investor might pass. Use 합쇼체. Counter-intuitively, this builds trust. Markdown sections: '**한 줄 회사 정의**' (1줄), '**왜 우리가 망할 수 있나요 (top 3)**' (numbered — 각 항목 '시나리오 1줄' + '확률 (low / medium / high)' + '우리가 이걸 어떻게 줄이고 있나 1줄'), '**이 시장에서 우리가 모르는 것 3가지**' (numbered — 솔직히 우리도 답을 모르는 질문), '**경쟁사가 우리보다 잘하는 것**' (2-3 bullets — 인정), '**그럼에도 우리가 베팅하는 이유**' (1-2 단락 — 위 약점을 안고도 왜 이 회사가 의미 있는지), '**1년 뒤 자기 검증 질문**' (3 bullets — 1년 뒤 우리가 잘하고 있는지 알려줄 구체적 신호).\n\n회사 맥락:\n${text}`,
  weekly_1_1_agenda_ko: (text) =>
    `Build a weekly 1:1 agenda template in Korean for a manager↔direct report meeting. Use 해요체. 30-minute slot 가정. Markdown sections with time budget: '**0-3분 / 안부 & 컨텍스트**' (1-2 bullets — 가벼운 질문 예시), '**3-10분 / 직원 의제 (먼저)**' (3 bullets — 이번 주 가장 어려웠던 것, 우선순위 헷갈리는 것, 도와줬으면 하는 것), '**10-20분 / 진척 & 막힘**' (bullets — 진행 중인 일 status / 막힌 결정 / 데이터), '**20-25분 / 매니저 의제**' (bullets — 피드백 1개, 회사/팀 컨텍스트 공유 1개), '**25-30분 / 커리어 & 관계**' (2 bullets — 격주로: 한 주는 성장 / 한 주는 관계). 끝에 '**Action items 캡처**' (1줄 — '결정 / 액션 / 다음 1:1에 다시 볼 것 3줄로 정리').\n\n맥락 (역할 / 관계 / 최근 이슈):\n${text}`,
  marketing_tagline_ab_test_ko: (text) =>
    `Generate 6 Korean tagline variants for A/B testing the product / promise below. Use 해요체 (혹은 명사형). 각 variant는 명확히 다른 각도. Format each as '### Variant N — [각도명]' followed by '**Tagline**' (1줄, 14자 이내), '**Subline**' (1줄, 28자 이내), '**가설**' (1줄 — 이 카피가 이기면 무엇을 의미하는지). 각도: 1) 베네핏 중심, 2) 페인 중심, 3) 시간 절약 / 효율, 4) 정체성 / 자기표현, 5) 안전 / 보장, 6) 호기심 / 의외성. 끝에 '**테스트 권고**' (3 bullets — 1) 어떤 지표를 봐야 하나 (CTR / SU rate / 체류 시간), 2) 어떤 모수면 결과를 신뢰할 수 있나, 3) 결과 보기 전에 우리가 한 가설 미리 기록).\n\n제품 / 약속:\n${text}`,
  user_journey_map_ko: (text) =>
    `Build a Korean user journey map for the persona / scenario below. Use 해요체. Markdown sections: '**페르소나 한 줄**' (1줄 — 누구 / 무엇을 하려고), '**시나리오 한 줄**' (1줄 — 어떤 task / 어떤 트리거), '**단계별 여정 (테이블)**' (컬럼: '단계 | 행동 | 생각 | 감정 (😡/😐/🙂/😀) | 우리 접점 | 페인 포인트'. 단계 5-7개, 인식 → 고려 → 시도 → 사용 → 평가 → 재방문 흐름), '**최고의 순간 (peak)**' (1줄 — 어디서 가장 좋은 감정), '**최악의 순간 (low)**' (1줄 — 어디서 가장 안 좋은 감정), '**개선 기회 3가지**' (numbered — peak는 더 살리고 low는 줄이는 구체적 제안. 각 항목 '단계 | 제안 | 예상 임팩트').\n\n페르소나 / 시나리오:\n${text}`,
  translate_ko_to_chinese: (text) =>
    `Translate the Korean text below into natural Mandarin Chinese (简体中文). 직역 금지, 중국어 독자가 자연스럽게 읽도록 의역. 한국식 외래어는 중국에서 통용되는 표현으로 대체 ('아이폰' → 苹果手机/iPhone, 컨텍스트에 따라). 격식은 원문 톤에 맞춤 (존댓말 → 礼貌正式体, 반말 → 口语化). Reply with two sections: '**翻译**' (the translated text) and '**翻译笔记**' (3 bullets in Korean — 핵심 의역 결정 1가지 / 중국 문화 컨텍스트 고려한 단어 선택 1가지 / 원문 뉘앙스 중 살리기 어려웠던 것 1가지).\n\n원문:\n${text}`,
  fundraising_pipeline_update_ko: (text) =>
    `Convert raw fundraising notes into a Korean pipeline update memo for the founding team. Use 합쇼체. Markdown sections: '**현재 라운드 한 줄**' (1줄 — 'Seed / Series A / 브리지 — 목표 X억 — 현재 Y억 LOI'), '**파이프라인 테이블**' (컬럼: '투자자 | 단계 (1차 / 2차 / DD / 텀시트 / 확정) | 마지막 컨택 일자 | 다음 액션 | 비고'. 현재 진행 중인 투자자만), '**Hot leads (이번 주 집중)**' (numbered — 3개 — 각 '왜 hot인지' 1줄), '**Cold / passed**' (bullets — 누가 / 왜 passed — 학습 1줄 포함), '**다음 주 액션 5가지**' (numbered — 구체적 누구한테 / 무엇을), '**팀에 부탁할 것**' (있으면 bullets — '@이름님 X 투자자한테 워런트로 소개 가능?' 류).\n\n파이프라인 노트:\n${text}`,
  tech_debt_priority_ko: (text) =>
    `Score and prioritize the tech debt items below for an engineering team. Use 해요체. Markdown sections: '**평가 기준 (1줄씩)**': '- 통증 (Pain)' / '- 영향 범위 (Reach)' / '- 해결 노력 (Effort)' / '- 깨질 위험 (Risk)' — 각 1-5 척도, '**스코어 테이블**' (컬럼: '항목 | 통증 | 영향 | 노력 | 위험 | 점수 ((통증×영향)÷노력) | 추천 분기'), '**Top 3 (지금 할 것)**' (numbered — 각 '왜 지금' 1줄 + '첫 PR 단위 추천' 1줄), '**나중에 / 안 할 것**' (bullets — 점수 낮은 이유 1줄). 입력에 있는 항목들의 원문을 변형하지 말고 그대로 사용.\n\n기술 부채 리스트:\n${text}`,
  saas_renewal_email_ko: (text) =>
    `Draft a Korean SaaS renewal reminder email to a customer 30 days before their contract renewal. Use 해요체, 영업 압박 톤 금지 — partnership 톤. Markdown sections: '**제목**' (1줄, 27자 이내 — '[고객사명] 갱신 안내 — D-30' 류), '**프리헤더**' (1줄, 90자 이내 — 갱신을 결정할 핵심 가치 1가지), '**본문**' (4 단락: 1) 한 줄 인사 + '계약이 [날짜]에 만료됩니다' 사실 안내 1줄, 2) 지난 1년간 이 고객이 받은 가치 — 가능하면 수치 (사용량 / 절약된 시간 / 도입 사례) 2-3줄, 3) 다음 1년에 새로 받을 가치 — 곧 출시될 기능 1-2개 미리 살짝 1줄, 4) 갱신 다음 단계 — '30분 콜로 함께 검토하실까요?' 1줄), '**P.S.**' (1줄 — 결정에 영향을 줄 새 가격 / 플랜 변경이 있으면 솔직히 한 줄).\n\n고객 맥락:\n${text}`,
  interview_invite_email_ko: (text) =>
    `Write a Korean interview invitation email from a recruiter / hiring manager to a candidate. Use 해요체, 따뜻하지만 명확하게. 후보자의 시간을 존중하는 톤. Markdown sections: '**제목**' (1줄, 28자 이내 — '[회사명] [포지션] 인터뷰 안내' 류), '**본문**' (4 단락: 1) 지원 / 추천 감사 + 이 사람을 왜 만나고 싶은지 1줄 — 이력서 / 포트폴리오에서 인상 깊었던 구체적 1가지 reference, 2) 인터뷰 구조 — 몇 라운드 / 각 라운드 시간 / 어떤 형식 (대화 / 라이브 코딩 / 발표 등), 3) 첫 라운드 일정 옵션 3개 — 'YYYY-MM-DD HH:MM KST' 형식, 4) 후보자가 알면 좋은 자료 — JD 링크 / 회사 1페이저 / 우리 팀 블로그 등 2-3개), '**문의처**' (1줄 — 채용 담당자 이름 / 이메일 / Slack 가능 여부).\n\n포지션 / 후보자 맥락:\n${text}`,
  press_pitch_email_en: (text) =>
    `Write an English press pitch email to a journalist for the story / launch below. Tight, no fluff — assume the journalist gets 100 pitches a day. Markdown sections: '**Subject**' (1 line, under 60 characters — specific noun + verb, no 'we are excited to announce'), '**Body**' (4 short paragraphs: 1) 1-line opener — why I'm writing TO YOU specifically (reference a recent piece they wrote), 2) the news in 1-2 sentences — what / when / why it matters now, 3) what makes the story interesting beyond the announcement — data point, contrarian angle, or first/biggest claim — 1-2 sentences, 4) what I can offer — exclusive access, embargoed details, founder time, dataset — 1-2 sentences), '**Sign-off**' (1 line — name + 1-line title + the most credible link to learn more). After the email, '**Why this hook**' (2 bullets in Korean — 이 기자에게 이 후크를 고른 이유 + 우리가 빼고 들어간 정보 1가지).\n\nStory / journalist context:\n${text}`,
  release_video_script_ko: (text) =>
    `Write a 2-minute Korean release video script announcing the feature / product below. 화자 1명 (PM 또는 창업자), 친근하고 명확한 톤, 화면 전환 명시. Use 해요체. Markdown structure per scene: '### Scene N (MM:SS-MM:SS) — [장면명]' followed by '**On-screen**' (1-2줄 — 화면 / 그래픽 / 데모) and '**Voiceover**' (1-3 문장, 따옴표 안에). 권장 구성: Scene 1 (0:00-0:15) Hook — 사용자 페인 1가지로 시작, Scene 2 (0:15-0:35) 오늘 무엇이 새로워졌는지 한 줄 약속, Scene 3 (0:35-1:15) 데모 30초 — 가장 매혹적인 1개 use case, Scene 4 (1:15-1:45) 우리가 이걸 왜 만들었나 / 누구를 위해 만들었나 — 페르소나 1명 reference, Scene 5 (1:45-2:00) CTA — 어디 가서 / 무엇을 하면 되는지 + 한 줄 클로징. 끝에 '**촬영 / 편집 메모**' (2 bullets — 톤 키워드 1가지 + B-roll 후보 1가지).\n\n릴리스 내용 / 페르소나:\n${text}`,
  user_research_plan_ko: (text) =>
    `Generate a Korean user research plan for the question below. Use 해요체. Markdown sections: '**리서치 질문 (1줄)**' (1줄 — '~인가요?' 또는 '~은 무엇인가요?' 형식, yes/no 너무 단순하지 않게), '**우리가 안다고 가정하는 것 vs 모르는 것**' (2개 컬럼 markdown table — 검증/반증할 가설 1줄씩), '**방법**' (1-2줄 — 인터뷰 / 다이어리 / 사용성 테스트 / 설문 중 무엇을 / 왜), '**모수**' (bullets — N명 / 페르소나 / 모집 채널 / 인센티브), '**스크립트 핵심 질문 5개**' (numbered — 열린 질문, 행동을 묻는 질문 위주 — '왜'보다 '어떻게' / '마지막으로 했을 때'), '**일정**' (테이블 — '단계 | 기간 | 책임자'. 모집 / 진행 / 분석 / 공유), '**분석 + 공유 형식**' (1-2줄 — 산출물 무엇 / 누구에게 / 언제), '**연구 윤리**' (1-2 bullets — 동의 / 데이터 보관 / 익명화).\n\n리서치 컨텍스트:\n${text}`,
  stakeholder_meeting_summary_ko: (text) =>
    `Compress a multi-stakeholder meeting's raw notes into a Korean meeting summary email. Use 합쇼체. Markdown sections: '**제목**' (1줄, 30자 이내 — '[프로젝트 / 주제] 미팅 정리 — YYYY-MM-DD' 류), '**한 줄 결론**' (1줄 — 미팅이 무엇을 결정했는지 / 미결인지), '**참석자**' (1줄 — 이름 + 소속/역할 쉼표 구분), '**결정 사항**' (numbered — '결정: ... / 결정자: ... / 시점: ...' 형식. 각 1줄), '**Action items**' (테이블 — '담당자 | 액션 | 마감 | 의존성'), '**다룬 의제별 핵심**' (bullets — 의제명 + 한 줄 요약 + 핵심 인용 1개), '**열린 질문 / 미결**' (bullets — 누가 / 언제까지 답할지 명시), '**다음 미팅**' (1줄 — 일정 + 안 정해졌으면 '추후 조율').\n\n미팅 노트 원본:\n${text}`,
  support_ticket_response_ko: (text) =>
    `Draft a Korean customer support reply to the inbound ticket below. Use 해요체. 톤은 사과 한 번 + 해결 중심, 변명 / 책임 회피 / 'as per policy' 류 단어 금지. Markdown sections: '**개인 인사 + 공감**' (1줄 — 고객 이름 + 한 줄 공감 — '많이 불편하셨겠어요' 류), '**우리가 확인한 것**' (1-2줄 — 이 티켓을 받고 우리가 한 확인 — '계정 로그를 봤어요', '관련 기능 재현했어요' 등), '**해결 / 안내**' (numbered — 1) 즉시 우리가 한 것 (있으면), 2) 고객이 지금 할 수 있는 것 — 단계별로 정확히, 3) 우리가 follow-up 할 것 + 시점), '**Why it happened (가능하면)**' (1-2줄 — 사용자가 알면 도움될 수준에서 — internal jargon 금지), '**다음 액션 + CTA**' (1줄 — 무엇을 시도하고 안 되면 어디로 답장), '**서명**' (1줄 — 이름 + 팀명). 끝에 '**Internal note (고객에게 보이지 않음)**' (2 bullets — 1) 이 케이스가 일반화될 가능성 1줄, 2) 제품 / 문서에 어떤 변경이 필요할지 1줄).\n\n티켓 내용:\n${text}`,
  github_issue_template_ko: (text) =>
    `Generate a structured Korean GitHub issue from the rough bug / feature note below. Auto-detect whether it's a bug or feature request from context. Output a markdown body ready to paste. If **bug**: '### 요약' (1줄), '### 재현 단계' (numbered, 각 단계 한 동작), '### 기대 결과' (1-2줄), '### 실제 결과' (1-2줄), '### 환경' (bullets — OS / 버전 / 브라우저 등), '### 추가 정보' (bullets — 스크린샷 자리 / 관련 로그 / 우회 방법). If **feature**: '### 문제 / 동기' (2-3줄 — '왜 필요한가요'), '### 제안하는 해결' (2-3줄 — '무엇이 어떻게 작동했으면'), '### 대안 (고려한 것)' (bullets — 검토한 다른 방법과 왜 안 골랐는지), '### 영향 범위' (bullets — 누가 혜택 / 어떤 화면이 바뀜), '### 추가 컨텍스트' (bullets). 끝에 라벨 제안 1줄 ('bug / enhancement / good-first-issue / needs-design' 중에서).\n\n원본 노트:\n${text}`,
  data_dashboard_narrative_ko: (text) =>
    `Read the dashboard numbers / metrics dump below and write a Korean narrative summary — '대시보드 못 보는 사람에게도 이번 주 무슨 일이 있었는지 한 페이지로 전달'. Use 해요체. Markdown sections: '**한 줄 헤드라인**' (1줄 — 가장 중요한 변화 1개를 평어/체언지 명사형으로), '**핵심 메트릭 3개 (서사형)**' (3 단락, 각 메트릭마다: 'KPI 이름 — 현재 X (전주/전월 대비 ±Y%)' 1줄 + 그 변화의 의미 2-3줄 — '이게 왜 의미 있는지, 무엇이 그 변화를 만든 것 같은지, 우리가 더 봐야 할 것이 있는지'), '**숨겨진 신호**' (2 bullets — 큰 변화 아래에 있는 작은 시그널 — 코호트 차이 / 채널 차이 / 사용자 세그먼트 차이), '**다음 주에 우리가 더 봐야 할 것**' (2 bullets — 데이터로 답해야 할 질문 형태). 추측은 '추정' 명시.\n\n대시보드 데이터:\n${text}`,
  onboarding_checklist_30day_ko: (text) =>
    `Build a Korean 30-day onboarding checklist for a new employee in the role described below. Use 해요체. Markdown sections per week: '### Week 1 — 적응 (Setup & shadow)', '### Week 2 — 이해 (Context & people)', '### Week 3 — 손대기 (First small ship)', '### Week 4 — 자기 일 (Own a slice)'. 각 주마다 4-6개 체크박스 항목 '- [ ] ...' 형식, 항목은 결과 중심 — 'X 미팅 참석' 보다는 'X 미팅 후 우리 팀이 이 분기 어떻게 평가받는지 본인 말로 설명할 수 있다'. 매주 마지막 항목은 '- [ ] 본인 매니저와 30분 회고 — 이번 주 잘 된 것 / 헷갈리는 것 1개씩'. 끝에 '**Day 30 — 본인이 답해야 할 5가지 질문**' (numbered — 30일 끝에 본인이 명확히 답할 수 있어야 하는 질문들 — 'X 결정의 history는?', '우리 팀이 다음 분기 가장 큰 베팅은?' 류).\n\n역할 / 팀 컨텍스트:\n${text}`,
  advisor_outreach_ko: (text) =>
    `Draft a Korean cold outreach email to a potential advisor (industry expert, founder, exec). Use 해요체, 진심 + 짧고 명확. 본인 자랑 / 회사 자랑 최소화, 상대 시간 존중. Markdown sections: '**제목**' (1줄, 22자 이내 — '[그쪽 회사/주제] 관련 짧은 부탁' 류 — 부담 없는 prelude), '**본문**' (4 단락: 1) 어떻게 알게 됐는지 1줄 — 구체적 1가지 (책 / 글 / 인터뷰 인용) — '대단합니다' 같은 빈말 금지, 2) 우리가 누구인지 — 회사 1줄 + 우리가 지금 풀고 있는 문제 1줄, 3) 부탁 — 정확히 무엇 — '한 달에 30분 통화 1번' 류 작게 시작, 어드바이저로 정식 영입은 두 번째 대화 이후 제안, 4) 답이 안 와도 괜찮다는 한 줄 + 작은 감사), '**P.S.**' (1줄 — 상대가 가볍게 도와줄 다른 방식 1가지 — '소개해주실 만한 분 1명' 등).\n\n상대 / 우리 컨텍스트:\n${text}`,
  product_hunt_launch_post_ko: (text) =>
    `Write a Korean Product Hunt launch comment / first-comment post for the product below. Use 해요체. PH 첫 댓글은 만든 사람이 직접 stories를 풀어내는 자리 — 마케팅 카피 톤 금지. Markdown structure: '**Hook (1-2줄)**' (왜 만들었는지 짧은 개인적 동기 — 본인 페인 경험에서 시작), '**제품 한 줄 약속**' (1줄 — 누구를 위한 무엇), '**오늘 출시한 것 (3 bullets)**' (구체적 기능 3개, 각 1줄 — 베네핏 강조), '**Hunter들에게 부탁**' (1단락 — 무엇을 시도해보고 어떤 피드백이 도움될지 — '꼭 별 5개 주세요' 류 금지), '**오늘만 (선택)**' (있으면 1줄 — 런치데이 특별 혜택 / 코드), '**감사**' (1단락 — 도와준 팀 / 베타 사용자 / 추천해준 사람 호명 — 가짜 이름 만들지 말기, 입력에 없으면 placeholder). 마무리는 'Q&A 들어가요, 무엇이든 물어봐주세요 ☕' 류 1줄. 전체 PH 영어 사용자도 많으므로 짧은 영문 TLDR을 맨 위에 1줄 (italic 처리).\n\n제품 / 만든이 컨텍스트:\n${text}`,
  customer_quote_card_ko: (text) =>
    `Convert raw customer interview / review notes into a polished Korean customer quote card ready for marketing use. Output 3 variants of different length. Each variant follows this format: '### Variant N — [용도]' followed by '> "...인용 한 줄..."' '— 이름, 직책 @ 회사명'. 길이: 1) **트위터 / SNS용** (인용 70자 이내 — 한 가지 통찰 또는 결과), 2) **랜딩 페이지 히어로용** (인용 110자 이내 — 베네핏 1개를 사람 말투로), 3) **사례 연구용** (인용 200자 이내 — 페인 → 시도 → 결과 미니 서사). 원본 발언에 없는 내용을 만들지 말기 — 단어 다듬기와 압축만 허용. 끝에 '**사용 동의 체크리스트**' (3 bullets — 인용 사용 전 확인할 것: 본인 동의 / 회사 동의 / 가장 최근 직책 확인).\n\n원본 인터뷰 / 리뷰 노트:\n${text}`,
  release_email_internal_ko: (text) =>
    `Draft a Korean internal-only release announcement email — for the whole company, not customers. Use 합쇼체. 내부용이므로 마케팅 톤 금지, 동료들이 알아야 할 사실 위주. Markdown sections: '**제목**' (1줄, 28자 이내 — '[기능명] 내부 출시 안내 — YYYY-MM-DD' 류), '**한 줄 요약**' (1줄 — 무엇이 / 누구에게 / 언제부터), '**무엇이 새로워지나요**' (3 bullets — 기능 핵심 — 사진 / 영상 자리 placeholder 1줄 포함), '**왜 만들었나요**' (1-2줄 — 우리가 풀려고 한 문제, 의사결정 history 짧게), '**팀별 영향**' (테이블 — '팀 | 영향 | 액션'. 영업 / CS / 마케팅 / 데이터 등 영향 받는 팀만), '**아직 안 하는 것 (out of scope)**' (2 bullets — 자주 묻는 '그럼 X도 되나요'에 대한 솔직한 답), '**KPI / 우리가 무엇을 볼 것인가**' (2 bullets — 출시 후 1주 / 1달에 우리가 추적할 지표), '**문의처**' (1줄 — Slack 채널 + 책임 PM 이름).\n\n릴리스 내용:\n${text}`,
  ux_microcopy_5_states: (text) =>
    `Write Korean UX microcopy for the 5 most common UI states of the feature described below. Use 해요체. Markdown structure per state: '### N. [상태명]' followed by '**Headline**' (1줄, 18자 이내), '**Body**' (1줄, 60자 이내 — 사용자가 무엇을 할지 / 무엇이 일어났는지), '**CTA / Action label**' (1줄, 8자 이내 — 동사형, 'OK' 금지). 5 상태: 1) Empty (처음 사용 / 데이터 없음 — 호기심 + 첫 액션), 2) Loading (로딩 중 — 무엇을 기다리는지), 3) Success (성공 — 다음 단계 자연스럽게), 4) Error (실패 — 사용자 잘못 단정 금지, 다음 액션 명확), 5) Limit / Empty after action (검색 결과 없음 / 한도 도달 — 막다른 길 아니라 옆문 제시). 끝에 '**일관성 노트**' (2 bullets — 5개 카피에 공통으로 흐르는 톤 1가지 + 의식적으로 피한 표현 1가지).\n\n기능 / 상황:\n${text}`,
  translate_jp_to_ko: (text) =>
    `Translate the Japanese text below into natural Korean. 일본어 직역체 (오시메나ど로/오리코미 등) 금지, 한국어로 자연스럽게. 원문 격식에 맞춤 — 「です・ます」체 → 해요체, 정중하지만 친근하게 / 「だ・である」체 → 평어, 단정적으로 / カジュアル → 반말, 자연스럽게. 일본식 비즈니스 관용구 ('お世話になっております' 등)는 한국 비즈니스에서 어색하면 한국식 인사로 의역. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 일본식 관용구 → 한국식 의역 1가지, 2) 한국어에서 어색해질 수 있던 부분과 처리, 3) 한자어 vs 고유어 선택 1가지).\n\n원문 (日本語):\n${text}`,
  weekly_okr_check_in_ko: (text) =>
    `Write a Korean weekly OKR check-in summary for a team. Use 해요체. Markdown sections: '**한 줄 분위기**' (1줄 — 'on track / at risk / blocked' 영문 라벨 + 1줄 해석), '**O별 진척**' (Objective 별로 '### O1. [Objective]' followed by 'KR 진척' (각 KR 1줄 — '- KR: ... → 현재 X / 목표 Y / 신뢰도 (low/medium/high)'), 'Health check 1줄' — 이 O가 이번 주 더 좋아졌는지/나빠졌는지/같은지), '**막힘 / 의존성**' (bullets — 어떤 KR가 누구의 결정/리소스 때문에 막혔는지), '**이번 주 베팅**' (3 bullets — 다음 7일에 우리가 집중할 것 — 결과 중심), '**도움 요청**' (있으면 bullets — '@이름 / 무엇을 / 언제까지' 형식).\n\nOKR 현재 상태 + 이번 주 활동:\n${text}`,
  executive_decision_brief_ko: (text) =>
    `Compress the situation below into a Korean executive decision brief — 'CEO가 30초 안에 읽고 결정할 수 있는 한 페이지'. Use 합쇼체. Markdown sections: '**결정 요청 (1줄)**' (1줄 — 'X 대 Y 중 무엇을 할지 결정 요청드립니다' 형식), '**한 줄 추천**' (1줄 — 굵게 — 'X를 추천합니다 — 이유 한 절'), '**상황 (3줄 이내)**' (배경 — 모르는 사람도 이해할 수 있게, 빠르게), '**옵션 비교 (테이블)**' (컬럼: '옵션 | 장점 1줄 | 단점 1줄 | 비용/일정 | 위험'), '**우리 추천 옵션의 가정**' (2 bullets — 이 추천이 깨질 만한 가정 — '경쟁사 X가 6개월 안에 진입하지 않는다면' 류), '**결정이 늦으면 잃는 것**' (1줄 — '다음 분기 전에 결정 못 하면 …'), '**필요한 것**' (1줄 — 'OK / NO / 미팅 1회' 중 선택지 명시).\n\n결정 상황:\n${text}`,
  translate_de_to_ko: (text) =>
    `Translate the German text below into natural Korean. 독일어 특유의 긴 복합 명사 / 종속절을 한국어 어순과 호흡에 맞게 재구성 — 직역 금지. 격식은 원문 톤에 맞춤 ('Sie' → 해요체 또는 합쇼체 / 'du' → 반말). 독일어 비즈니스 / 기술 어휘는 한국에서 통용되는 한글 또는 영어로. 'Datenschutz' 같이 한국에 정확한 1대1 단어가 없는 경우 의역 + 1줄 노트. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 긴 복합 명사 해체 1가지, 2) 독일식 종속절 → 한국식 절 재구성 1가지, 3) 정확한 대응 단어 없어 의역한 것 1가지).\n\n원문 (Deutsch):\n${text}`,
  user_interview_invite_email_ko: (text) =>
    `Draft a Korean email inviting a user to a 30-minute user interview. Use 해요체. 상대 시간 존중, 영업 또는 광고 톤 금지 — research 톤. Markdown sections: '**제목**' (1줄, 28자 이내 — '[제품명] 사용 경험에 대해 30분 대화 부탁드려요' 류), '**본문**' (4 단락: 1) '[제품명]을 써주셔서 감사합니다' + 어떤 사용 신호를 보고 연락하는지 1줄 — 'X를 자주 쓰시는 분들을 직접 만나고 있어요' 류, 2) 우리가 이 인터뷰로 알고 싶은 것 — 1-2줄, 'A를 더 좋게 만들고 싶어서' 정도로 솔직히, 3) 일정 옵션 3개 — 'YYYY-MM-DD HH:MM KST (Zoom)' 형식 + 시간 안 맞으면 답장 부탁 1줄, 4) 사례 — '대화 끝나면 [기프티콘 / 1개월 무료 / 작은 사례비] 보내드려요' 1줄 — 입력에 없으면 생략), '**FAQ 짧게**' (2 bullets — '이 대화는 녹화하나요?' 'YES/NO + 이유' / '내 의견이 제품에 반영되나요?' '정직한 답').\n\n사용자 / 리서치 컨텍스트:\n${text}`,
  ad_landing_copy_ko: (text) =>
    `Write Korean copy for a paid-ad landing page (광고 도착 페이지). Use 해요체. 사용자가 광고 클릭으로 들어왔다는 가정 — 첫 화면에서 광고 약속을 즉시 확인시켜야 함. Markdown sections (each is a section of the landing page): '**H1 헤드라인**' (1줄, 18자 이내 — 광고와 정확히 같은 약속을 큰 글자로), '**H2 서브헤드라인**' (1줄, 30자 이내 — '누구를 위한, 왜 다른지' 1문장), '**Hero CTA**' (1줄, 7자 이내 동사형 — '지금 시작하기', '14일 무료', '데모 신청' 류), '**소셜 프루프 1줄**' (1줄 — '이미 X 팀에서 사용 중' 또는 '★★★★☆ 4.8 / 500+ 리뷰' — 입력에 데이터 없으면 placeholder), '**핵심 베네핏 3개 (h3 + 1줄)**' (각 'h3 한 줄' + 베네핏 설명 1줄), '**Objection handle 2가지**' (2 bullets — '비싸지 않나요?' '복잡하지 않나요?' 류 예상 의심과 1줄 답), '**최종 CTA + risk reversal**' (1줄 CTA + '취소는 1클릭, 결제 정보 필요 없음' 류 1줄).\n\n광고 / 제품 컨텍스트:\n${text}`,
  marketing_campaign_brief_ko: (text) =>
    `Build a Korean marketing campaign brief from the goal below. Use 해요체. Markdown sections: '**캠페인 한 줄 (One sentence campaign)**' (1줄 — '누구에게 / 무엇을 / 어떤 행동을 일으키고 싶은가' 한 문장), '**목표 (Goal)**' (1줄 — 측정 가능한 결과 — '신규 가입 N건 in M주' 형식), '**KPI 3개**' (bullets — 메인 + 보조 2개), '**타깃 (Audience)**' (1-2 단락 — 페르소나 + 어디서 우리를 처음 만날지), '**핵심 메시지 1줄**' (1줄 — 따옴표 안에), '**채널 믹스 (테이블)**' (컬럼: '채널 | 포맷 | 메시지 변형 | 예산 비중'), '**일정 (테이블)**' (컬럼: '주 | 활동 | 담당자 | 산출물'), '**예산**' (1-2줄 — 총액 + 분배 비율), '**위험 / 가정**' (2 bullets — 캠페인이 실패할 만한 시나리오), '**측정 / 종료 기준**' (1-2 bullets — 언제 / 어떻게 평가).\n\n목표 + 컨텍스트:\n${text}`,
  team_value_workshop_ko: (text) =>
    `Design a 90-minute Korean team values workshop agenda for a team of N people. Use 해요체. Markdown sections: '**워크숍 목표 (1줄)**' (1줄 — '이 90분이 끝나면 팀이 무엇을 명확히 알아야 하는지'), '**준비물**' (bullets — 화이트보드 / 포스트잇 / 스티커 dots / 노트북 / 사전 설문 등), '**아젠다 (테이블)**' (컬럼: '시간 | 활동 | 형식 (개인/페어/전체) | 산출물'. 권장 골격: 0-10분 인트로 + 안전감 만들기, 10-30분 개인 발산 — '내가 일하면서 자랑스러웠던 순간 3개 + 그때 우리가 어떻게 행동했나' 회상, 30-50분 페어 공유 + 패턴 추출, 50-70분 전체 — 팀 가치 후보 4-6개 클러스터링, 70-85분 dot voting + 합의 — 가치 3개로 좁히기, 85-90분 다음 단계 — 가치 정의 작성 책임자 / 시점), '**퍼실리테이터 가이드**' (3 bullets — 발언 균형 / 침묵 다루기 / '회사 위에서 내려준 가치 베끼기' 회피하는 법), '**워크숍 후 산출물 템플릿**' (1-2줄 — '각 가치마다 정의 1줄 / 이러면 어긋남 1가지 / 우리가 이 가치를 보여줬던 최근 사례 1개').\n\n팀 컨텍스트:\n${text}`,
  incident_runbook_ko: (text) =>
    `Generate a Korean incident response runbook for the failure mode described below. Use 합쇼체. 새벽 3시 oncall이 잠 깬 채로 따라 할 수 있게. Markdown sections: '**증상 (Symptom)**' (1-2 bullets — 알림 / 모니터링에서 무엇을 본 순간 이 런북을 펴는지), '**Severity 판정 (1줄)**' (1줄 — Sev1/2/3 어떤 기준으로 판정), '**즉시 액션 (Triage, < 5분)**' (numbered — 1) 영향 확인 명령어 1줄 + 결과 해석, 2) 페이지 / 알림 / 책임자 호출, 3) 임시 완화 — 트래픽 차단 / 캐시 무효화 / feature flag off 등), '**진단 (Diagnose, 5-30분)**' (numbered — 무엇을 어디서 확인. 로그 / 메트릭 / DB 쿼리 — 각 단계 명령어 또는 링크 placeholder), '**복구 (Recover)**' (numbered — 단계별 복구 액션 + 각 단계의 검증 방법), '**사후 (Post-incident)**' (bullets — 사후 보고서 / 사용자 공지 / 모니터링 강화 / 런북 업데이트), '**관련 자료**' (bullets — 관련 페이지 / 대시보드 / 슬랙 채널 placeholder).\n\n장애 시나리오:\n${text}`,
  product_market_fit_survey_ko: (text) =>
    `Build a Korean Product-Market Fit survey based on Sean Ellis's canonical 'how would you feel if you could no longer use [Product]' methodology, adapted for the product described below. Use 해요체. Markdown sections: '**서베이 목표 (1줄)**' (1줄), '**모수 권장**' (1줄 — 최소 N명 / 최근 X주 안에 active 사용자), '**메인 질문 1**' ('[제품명]을 더 이상 쓸 수 없게 된다면 기분이 어떨까요?' — 4 옵션: 매우 실망 / 약간 실망 / 별 차이 없음 / 이미 안 씀), '**메인 질문 2 (열린 답)**' ('[제품명]에서 가장 가치 있게 느끼는 한 가지는 무엇인가요?' — open text), '**메인 질문 3 (열린 답)**' ('[제품명]이 가장 도움이 될 사람을 한 문장으로 묘사한다면?' — open text), '**메인 질문 4 (열린 답)**' ('가장 개선됐으면 하는 한 가지는?' — open text), '**보조 질문 3개**' (페르소나 / 빈도 / 다른 도구 비교), '**분석 가이드**' (bullets — 메인 질문 1에서 '매우 실망' 비율이 40% 이상이면 PMF 시그널 / Q2의 빈출 단어로 핵심 가치 추출 / Q3로 타깃 다듬기 / Q4를 우선순위 시그널로).\n\n제품 컨텍스트:\n${text}`,
  investor_thank_you_pass_ko: (text) =>
    `Write a Korean reply email to an investor who just declined to invest ('passed'). Use 해요체, 진심 + 짧고 품격 있게. 다음 라운드 / 다음 회사를 위해 관계를 잇는 것이 목표. 토라진 톤, 자기변호, 길게 설득 시도 절대 금지. Markdown sections: '**제목**' (1줄, 22자 이내 — '결정 감사드립니다' 류 짧고 담백), '**본문**' (3 단락: 1) 시간 내준 데 감사 + 결정 존중 1줄, 2) 그쪽이 우려한 1-2가지를 우리도 진지하게 받겠다 + 우리가 그것을 어떻게 다룰 계획인지 1-2줄 (방어하지 말고 학습으로), 3) 6-12개월 뒤 다시 업데이트 드려도 될지 가볍게 묻기 + 그동안 어떤 milestone을 우리가 보여드릴 수 있을지 1줄), '**P.S. (선택)**' (1줄 — 그쪽 포트폴리오 회사 중 우리가 도울 만한 게 있으면 작게 — 진심으로만, 빈말 금지).\n\n투자자 / 거절 맥락:\n${text}`,
  engineering_onboarding_repo_ko: (text) =>
    `Generate a Korean engineering onboarding doc for the repo described below. Use 해요체. 새 개발자가 1주일 안에 첫 PR을 머지할 수 있게 하는 게 목표. Markdown sections: '**Repo 한 줄**' (1줄 — 무엇을 / 누구를 위해), '**아키텍처 한 그림 (텍스트)**' (3-5줄 ASCII / 텍스트 다이어그램 — 핵심 컴포넌트와 데이터 흐름), '**Setup**' (numbered — 'clone → install → env → seed → run' 각 단계 명령어 1줄씩), '**중요 디렉토리 / 파일**' (테이블 — '경로 | 역할 1줄'), '**자주 쓰는 명령어**' (코드 블록 — 테스트 / 린트 / 빌드 / 배포 / 마이그레이션 등 6-8개), '**첫 PR로 추천하는 작업**' (3 bullets — easy / medium / advanced 난이도 1개씩, 각 'tag good-first-issue 라벨에서 찾을 수 있어요'), '**막힐 때 물어볼 사람 / 채널**' (3 bullets — 인프라 / 백엔드 / 프론트엔드 등 영역별), '**조심해야 할 것 3가지**' (numbered — 이 repo만의 함정 — '이 폴더는 자동 생성이라 수정 금지' 류).\n\nRepo 컨텍스트:\n${text}`,
  press_release_long_ko: (text) =>
    `Write a full-length (2-page) Korean press release for the announcement below. Use 합쇼체. PR 표준 형식 엄격 준수. Markdown sections: '**메타 라인**' (3줄 — '보도자료 / 즉시 배포 / 문의: 이름 연락처'), '**헤드라인**' (1줄, 40자 이내, who+what+impact), '**서브헤드라인**' (1줄, 80자 이내, 보완 정보), '**도시 + 날짜 + 리드 단락**' (서울, YYYY-MM-DD — 1단락 5줄 이내, 6하원칙 압축), '**본문 1 — 배경과 시장 맥락**' (2단락 — 왜 지금 / 시장에서 이 발표의 의미), '**본문 2 — 구체적 내용 + 수치**' (2단락 — 차별점 / 메트릭 / 데이터, 가능하면 인용 1개), '**임원 인용**' (1단락 — 임원 이름 / 직책 + 따옴표 안 발언 2-3줄 + 한 줄 맥락), '**고객 / 파트너 인용 (선택)**' (있으면 1단락), '**회사 소개 (보일러플레이트)**' (1단락 4-5줄 — 회사 정의 / 주요 사실 / 웹사이트), '**미디어 자료**' (1줄 — 이미지 / 영상 / 추가 데이터 어디서 받을 수 있는지), '**문의처**' (이름 / 직책 / 이메일 / 전화 — 형식 갖춰서).\n\n발표 컨텍스트:\n${text}`,
  founder_intro_email_warm_ko: (text) =>
    `Draft a warm Korean founder-to-founder intro email — '우리 회사가 그쪽에 한 가지 도움이 될 것 같아서 연락드립니다' 톤. Use 해요체. 영업/투자 권유 아님, 진짜 도움 또는 협업 가능성 탐색. Markdown sections: '**제목**' (1줄, 22자 이내 — '[회사명] [본인 이름] — 한 가지 부탁 + 한 가지 제안' 류), '**본문**' (4 단락: 1) 어떻게 알게 됐는지 1줄 + 그쪽 회사에서 본 구체적 1가지 — '최근 X 출시 정말 잘하셨더라구요, Y 부분이 인상 깊었어요' 류, 2) 본인 회사 1줄 정의 + 우리가 지금 어디 와 있는지 1줄, 3) 진짜 도움 또는 제안 — '저희 고객 중 X 산업이 많은데 그쪽 제품을 추천드려도 될까요' 또는 '저희가 Y 도구 평가 중인데 30분 사용 노하우 들어볼 수 있을까요' 류 구체적으로, 4) 답이 안 와도 괜찮다는 1줄 + 작은 응원), '**P.S.**' (1줄 — 가벼운 personal touch — 같은 도시 / 공통 지인 / 같은 분야 행사 등).\n\n상대 / 우리 컨텍스트:\n${text}`,
  customer_invoice_followup_ko: (text) =>
    `Draft a Korean invoice follow-up email to a customer whose payment is past due. Use 합쇼체. 톤 단계: 첫 follow-up은 friendly reminder, 두 번째는 formal but kind, 세 번째는 serious but not threatening. Output 3 versions in order: '### 1차 (D+3): 친절한 알림' / '### 2차 (D+10): 공식 안내' / '### 3차 (D+20): 마지막 안내'. 각 버전 'Subject:' (1줄, 25자 이내), '본문' (3 단락: 1) 가벼운 인사 + 인보이스 사실 안내 (번호 / 금액 / 만기일), 2) 무엇을 어떻게 해야 결제되는지 — 결제 링크 / 계좌 / 청구서 자리 표시, 3) 이미 결제했다면 무시 부탁 + 문제 있으면 답장 부탁). 3차에서는 'D+30 이후 서비스 잠시 보류' 류 결과를 명확히 알리되, 협박조 금지. 끝에 '**Internal 노트**' (2 bullets — 1) 이 단계가 작동 안 하면 다음 액션 1가지, 2) 청구 프로세스 자체에 개선할 만한 부분 1가지).\n\n인보이스 / 고객 상태:\n${text}`,
  developer_advocate_post_ko: (text) =>
    `Write a Korean developer advocate blog post — practical, code-first, 광고 톤 금지 — for the technical topic below. Use 해요체. Markdown structure: '**제목**' (1줄, 32자 이내 — 'X를 Y로 푸는 법' 또는 '왜 Z는 항상 W일까' 류 — '대박', '꼭' 같은 어그로 단어 금지), '**TLDR**' (1단락 3줄 — 무엇을 / 왜 / 어떻게 / 결과), '**문제**' (2-3 단락 — 본인이 만난 구체적 페인, 코드 / 에러 메시지 인용, 이 글의 독자가 'this is me' 라고 느끼게), '**시도해본 것 + 왜 안 됐는지**' (1-2 단락 — 막다른 길도 가치 있음, 코드 스니펫 포함), '**해결 — 단계별**' (numbered — 각 단계 한 줄 설명 + 코드 블록), '**작동 원리 (선택)**' (1-2 단락 — '왜 이게 되는지' 한 단계 더 깊게), '**조심할 것 / Trade-off**' (2 bullets — 이 해결의 한계 / 언제 다른 방법이 나은지), '**더 읽을 자료**' (3 bullets — 공식 문서 / 관련 RFC / 더 깊은 글 placeholder), '**다음에 다룰 것 (선택)**' (1줄). 코드 블록은 언어 명시.\n\n주제 / 본인 경험:\n${text}`,
  stretch_goal_okr_ko: (text) =>
    `Build a Korean 'stretch goal' OKR from the input below. Stretch OKR은 50-70% 달성 시 성공으로 보는 야망 목표. Use 해요체. Markdown sections: '**Stretch O (1줄)**' (1줄 — 영감 있는 정성적 목표, '... 만든다' 동사형. 안전한 목표는 stretch 아님), '**Stretch KR 3개**' (각 1줄 — 측정 가능한 숫자 + 기한 + 70% 달성 시 의미 있는 수치. 50% 달성도 자랑할 수 있어야 함), '**왜 stretch인가 (정당화)**' (3 bullets — 1) 무엇이 이 목표를 '편안한 범위 밖'으로 만드는지, 2) 100% 달성하려면 우리가 하지 않던 무엇을 해야 하는지, 3) 50% 달성도 회사에 어떤 의미인지), '**failure budget**' (2 bullets — stretch 목표 추구하다 망가져서는 안 되는 것 — 핵심 metric / 팀 건강), '**중간 체크 룰**' (1줄 — 분기 중 어느 시점에 어떤 신호를 보면 조정할지).\n\n팀 / 기간 / 야망 컨텍스트:\n${text}`,
  translate_french_to_ko: (text) =>
    `Translate the French text below into natural Korean. 프랑스어의 긴 형용사절 / 분사구문을 한국어 어순에 맞게 재구성, 직역 금지. 격식은 원문 톤에 맞춤 ('vous' → 해요체 또는 합쇼체, 'tu' → 반말). 프랑스어 비즈니스 / 학술 관용구는 한국어에서 자연스러운 표현으로 의역, 정확한 1대1 대응이 없는 단어는 의역 + 1줄 노트. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 긴 형용사절 → 한국식 절 재구성 1가지, 2) 의역한 관용구 1가지, 3) 정확한 대응 없어 의역한 단어 1가지).\n\n원문 (Français):\n${text}`,
  support_macro_collection_ko: (text) =>
    `Generate a collection of Korean support macros (자주 쓰는 응답 템플릿) from the common ticket categories below. Use 해요체, 친근하지만 공식. Markdown structure per macro: '### [매크로 이름]' followed by '**언제 쓰나요 (Trigger)**' (1줄 — 어떤 종류 티켓에서 이 매크로를 쓰는지), '**Variables 표시**' (1줄 — \`{고객명}\`, \`{주문번호}\`, \`{환불액}\` 같은 placeholder 목록), '**본문**' (3-5줄 — placeholder 포함된 응답 본문. 한 매크로가 모든 상황을 다 다루려 하지 말고 좁고 정확하게), '**Do / Don't**' (2 bullets — 이 매크로 쓰기 전에 확인할 것 1개 + 이 매크로로 답하면 안 되는 변형 케이스 1개). 입력의 카테고리 수만큼 매크로 생성, 보통 4-6개. 끝에 '**전체 매크로 사용 가이드**' (2 bullets — 1) 매크로 보낸 후 항상 추가할 한 줄 — 'edge case가 있으시면 답장 주세요' 류, 2) 매크로가 안 어울리는 케이스 판단법).\n\n티켓 카테고리:\n${text}`,
  linkedin_referral_request_ko: (text) =>
    `Draft a Korean LinkedIn DM asking for a referral / introduction at a target company. Use 해요체, 짧고 명확. LinkedIn DM은 첫 화면에 보이는 글자 수가 제한적이므로 첫 2줄로 승부. Markdown sections: '**메시지 (전체 600자 이내)**' (3-4 단락: 1) 어떻게 연결됐는지 1줄 + 그분이 한 일 구체적 1가지 (회사 / 최근 글 / 공통 지인 — '대단해 보여요' 류 빈말 금지), 2) 본인 누구 + 왜 그쪽 회사에 관심 — 1-2줄, 3) 정확한 부탁 — '[X] 포지션 채용 담당자 한 분 소개 가능하실까요' 형식, 작게, 4) 답이 안 와도 괜찮다는 1줄 + 가능하면 본인이 제공할 가치 1가지 — 'X 산업 자료 같은 거 필요하시면 공유드릴게요'), '**Follow-up 제안**' (1줄 — 1주일 후 답 없으면 보낼 짧은 follow-up 1줄 — '바쁘시죠? 답 시간 못 만드시면 OK해요. 그래도 한 번만 더 짚어드려요 :)').\n\n상대 / 본인 / 타깃 컨텍스트:\n${text}`,
  dashboards_alert_thresholds_ko: (text) =>
    `For the dashboard / metric set described below, propose Korean alert threshold definitions. Use 해요체. Markdown structure per metric: '### Metric: [이름]' followed by '**왜 이걸 보나요 (1줄)**', '**Baseline + 변동성**' (1줄 — 평소 값 / std), '**Warning threshold**' (1줄 — 값 + 1줄 설명 + 어떤 사람한테 알릴지 — Slack 채널 / oncall / 무알림), '**Critical threshold**' (1줄 — 값 + 1줄 설명 + 페이지 / 호출 정책), '**False positive 방지 룰**' (1줄 — 'N분 동안 X 이상 지속될 때만 발화' 류), '**관련 런북 placeholder**' (1줄). 끝에 '**Alert design 원칙 4가지**' (numbered — 1) 모든 알람은 누군가의 다음 행동을 정의해야 한다, 2) 알람 빈도가 주 N회 넘으면 threshold가 너무 민감, 3) critical 알람은 30분 안에 응답해야 의미 있다, 4) noisy 알람은 무시 습관을 만든다).\n\n메트릭 / 현재 baseline:\n${text}`,
  podcast_intro_30sec_ko: (text) =>
    `Write a Korean 30-second podcast cold-open intro for the episode below. 짧고 강하게 — 청자가 처음 30초에 '계속 들을 가치 있다' 결정. Use 해요체. Markdown sections: '**Hook (5-7초, 20자 이내)**' (1줄 따옴표 안 — 의외의 사실 / 도발적 질문 / 짧은 인용), '**Bridge (5-10초, 40자 이내)**' (1-2줄 — Hook과 에피소드를 연결, '오늘 게스트는 이걸 X 년간 직접 했어요' 류), '**Setup (10-15초)**' (2-3줄 — 게스트 1줄 소개 + 오늘 들을 핵심 1줄 + '~을 들으면 ~을 가져갈 수 있어요' 형태의 약속 1줄), '**탬포 / 호흡 메모**' (1줄 — 어느 단어에 호흡을 길게, 어느 단어에 음을 올릴지 1가지).\n\n에피소드 / 게스트 정보:\n${text}`,
  saas_winback_email_ko: (text) =>
    `Draft a Korean win-back email to a churned SaaS customer who cancelled 30-60 days ago. Use 해요체, 죄책감 유도 / 영업 압박 톤 금지. '바뀐 게 있어서 한 번만 보여드리고 싶어요' 톤. Markdown sections: '**제목**' (1줄, 24자 이내 — '[고객명]님, 그동안 잘 지내셨어요?' 류 — 마케팅 냄새 적게), '**프리헤더**' (1줄, 70자 이내 — 핵심 변경 1가지), '**본문**' (4 단락: 1) 짧은 안부 + '솔직히 떠나신 후 우리도 많이 생각했어요' 1줄, 2) 그 사이 우리가 한 의미 있는 변경 2-3가지 — 가능하면 고객이 떠난 이유와 연결, 3) 다시 시도해보실 의향 있으면 — 무료 1개월 / 1:1 가이드 / 특별 플랜 등 작은 미끼, 4) 안 돌아오시더라도 1줄 인사 + 'X에 대한 의견 들려주실 수 있을까요?' 1줄 — 답이 안 와도 OK 톤), '**P.S.**' (1줄 — 새 기능 1개 짧게 + 링크 placeholder).\n\n고객 / 이탈 맥락:\n${text}`,
  freelance_proposal_ko: (text) =>
    `Build a Korean freelance project proposal from the inquiry below. Use 합쇼체, 자신감 있지만 겸손. Markdown sections: '**프로젝트 한 줄**' (1줄 — '귀사의 X를 Y하도록 [본인]이 ~을 해드립니다'), '**이해한 문제 (Restate)**' (2-3줄 — 고객의 요청을 본인 말로 다시 풀어 — '제가 이해한 바로는 …'), '**제안하는 접근**' (numbered — 3-5 단계, 각 1-2줄 — 무엇을 어떤 순서로 어떤 산출물로), '**산출물 (Deliverables)**' (bullets — 명확히 무엇을 받게 되는지 — 파일 / 문서 / 코드 / 미팅), '**범위 밖 (Out of scope)**' (bullets — 헷갈리기 쉬운 인접 작업은 명시적으로 제외), '**일정**' (테이블 — '주차 | 마일스톤 | 산출물'), '**가격**' (1-2줄 — 총액 + 결제 단계 — '시작 시 50% / 1차 산출 시 30% / 완료 시 20%' 형식), '**전제 / 가정**' (2-3 bullets — 고객이 제공해줘야 할 것 / 가정이 깨지면 일정 영향 1줄), '**저에 대해**' (3-4줄 — 관련 경력 / 비슷한 작업 사례 1-2개 / 작업 스타일 1줄 — 자랑 톤 금지), '**다음 단계**' (1-2줄 — '동의하시면 ~일까지 견적서 / 계약 보내드립니다').\n\n프로젝트 inquiry:\n${text}`,
  translate_es_to_ko: (text) =>
    `Translate the Spanish text below into natural Korean. 스페인어의 풍부한 동사 활용과 감정 표현을 한국어로 자연스럽게 옮기되 직역 금지. 격식은 원문에 맞춤 ('usted' → 해요체 또는 합쇼체 / 'tú' → 반말). 라틴 아메리카 vs 스페인 스페인어의 어휘 차이는 입력에서 추론되는 지역의 뉘앙스를 살리되, 한국어 번역은 표준 한국어로. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 동사 시제 / 감정 뉘앙스 의역 1가지, 2) 한국어에 정확한 대응이 없는 표현 1가지와 처리, 3) 지역적 뉘앙스 (스페인 / 멕시코 / 아르헨티나 등) 추론과 번역 결정 1가지).\n\n원문 (Español):\n${text}`,
  weekly_email_newsletter_ko: (text) =>
    `Write a Korean weekly email newsletter from the curation notes below. Use 해요체. 친근하고 정직한 톤 — '이번 주의 진짜 좋은 것만' 큐레이션 약속 지킬 것. Markdown sections: '**제목**' (1줄, 28자 이내 — '#NN — [이번 주 한 줄 테마]' 형식, 숫자 / 주제 명확히), '**프리헤더**' (1줄, 90자 이내), '**오프닝 (Editor's note)**' (3-5줄 — 보낸 사람 한 마디. 이번 주 본인 생각 / 작은 일화 / 가벼운 안부), '**This Week's Picks (3-5개)**' (각 항목: '### [제목]' + '왜 골랐는지 1줄 (Editor's take)' + '> 원문 인용 또는 핵심 1줄 (선택)' + '→ [Read more](placeholder)'), '**Short notes (3 bullets)**' (각 1줄 — 짧게 공유할 링크 / 도구 / 사실), '**This week I'm trying**' (1줄 — 이번 주 본인이 시도해보는 것 — 인간미 보이는 자리), '**Reply prompt**' (1줄 — 독자가 답장할 만한 작은 질문). 마무리 '— [이름]' 1줄.\n\n이번 주 큐레이션 노트:\n${text}`,
  competitor_landing_breakdown_ko: (text) =>
    `Break down a competitor's landing page (described below) and produce a Korean teardown for our own marketing team. Use 해요체. Markdown sections: '**한 줄 인상**' (1줄 — 그 페이지를 처음 본 5초 인상), '**Hero 분석**' (3 bullets — H1 / H2 / CTA 그대로 인용 + 각 카피의 의도 1줄), '**핵심 메시지 흐름**' (스크롤 순서대로 5-7 단계 — 각 'Section 이름 | 메시지 1줄 | 잘함 / 보통 / 약함 표기'), '**그들이 잘하는 카피/디자인 3가지**' (bullets — 우리가 배울 수 있는 것), '**약한 곳 3가지**' (bullets — 우리가 다르게 할 기회 — 단순 폄하 금지), '**소셜 프루프 / 가격 / FAQ 전략**' (3 bullets — 각 영역에서 그들이 한 방식과 우리의 다른 방식 가능성), '**우리한테 적용할 3가지 아이디어**' (numbered — 베끼지 말고 우리 톤에 맞춰 어떻게 응용할지 구체적으로).\n\n경쟁사 페이지 설명:\n${text}`,
  engineering_blog_post_ko: (text) =>
    `Draft a Korean engineering blog post from the technical project / lesson below. Use 합쇼체 (또는 해요체, 일관 유지). 엔지니어 독자 대상 — 무엇을 / 왜 / 어떻게 / 트레이드오프 명확히. Markdown sections: '**제목**' (1줄, 35자 이내 — 결과 + 도구 + 맥락 — '~을 만든 / 푼 / 마이그레이션한 이야기' 류), '**TLDR**' (3-4줄 — 무엇 / 왜 / 핵심 트레이드오프 / 결과 수치), '**문제 정의**' (2-3 단락 — 비즈니스 맥락 + 기술적 제약 + 우리가 가진 데이터/규모), '**검토한 옵션들**' (각 'h3: 옵션 이름' + 1단락 — 왜 고려했고 왜 안 골랐는지), '**선택한 접근**' (2-3 단락 + 아키텍처 다이어그램 자리 placeholder + 핵심 코드 스니펫 1-2개), '**구현 중 만난 함정**' (numbered 2-3개 — 각 'Pitfall 한 줄 + 어떻게 알아챘는지 + 어떻게 해결했는지'), '**결과 + 측정**' (1-2 단락 — 메트릭 before/after, 가능하면 그래프 placeholder), '**무엇을 다시 한다면**' (2-3 bullets — 후회 + 다음에 비슷한 일 만나면 다를 결정), '**더 읽을 자료**' (3 bullets placeholder).\n\n프로젝트 / 배움 메모:\n${text}`,
  intern_project_brief_ko: (text) =>
    `Create a Korean 12-week intern project brief for the topic below. Use 해요체. 인턴이 끝났을 때 본인 포트폴리오에 자랑할 수 있고 회사에도 실제 가치가 나오는 프로젝트 디자인. Markdown sections: '**프로젝트 한 줄 (Outcome)**' (1줄 — '12주 후 우리는 [구체적 결과물]을 가진다'), '**왜 이 프로젝트인가 (회사 측 가치)**' (2-3줄 — 진짜 비즈니스 임팩트), '**왜 이 프로젝트인가 (인턴 측 성장)**' (2-3줄 — 인턴이 배울 스킬 / 만들 포트폴리오), '**범위 (Scope)**' (테이블 — '꼭 포함 / 가능하면 포함 / 명시적 제외'), '**12주 일정 (마일스톤)**' (테이블 — 'Week | 마일스톤 | 산출물 | 멘토 체크인 형식'. Week 1-2 학습 / 3-4 첫 prototype / 5-7 core feature / 8-9 데이터/평가 / 10 사용자 피드백 / 11 정리 / 12 발표), '**멘토링 구조**' (3 bullets — 매주 1:1 / 격주 데모 / 슬랙 채널 + 응답 시간), '**성공 기준**' (3 bullets — 측정 가능한 결과 — 'Week 12에 X 만들어졌고 Y 사용자가 써본다' 형태), '**위험 / 백업 plan**' (2 bullets — 일정 미끄러질 가능성 + 그때 줄이는 범위).\n\n인턴 / 주제 컨텍스트:\n${text}`,
  investor_referral_intro_ko: (text) =>
    `Write a Korean 'forwardable intro' email — the kind a warm investor would forward to other investors on our behalf. Use 합쇼체, 짧고 정보 밀도 높게. 받는 사람이 5초 안에 '미팅 잡을지' 판단할 수 있게. Markdown sections: '**제목**' (1줄, 30자 이내 — '[회사명] — [Stage] — [One-line]' 형식 — 예: 'Acme — Seed — 한국 중소상공인 인보이스 자동화'), '**본문 (forwardable copy)**' (3-4 짧은 단락: 1) 회사 한 줄 정의 + 시장 / 단계, 2) 트랙션 핵심 수치 3개 — MoM / ARR / retention 등, 3) 이번 라운드 — 목표 X억 + 누가 이미 들어왔는지 (있으면) + 마감 timeline, 4) 본인 한 줄 소개 + 다음 단계 — '15분 통화 가능하실까요 + [calendly placeholder]'), '**보내는 사람 → 소개자 메시지 (별도)**' (1단락 — 소개자에게 '이걸 그대로 forward하셔도 됩니다, 추가하실 한 줄 있으면 환영' 1줄 + 소개해줄 만한 사람 1-2명 후보 제안). 끝에 '**첨부 권장**' (bullets — deck / one-pager / 메트릭 시트).\n\n회사 / 라운드 컨텍스트:\n${text}`,
  customer_advisory_invite_ko: (text) =>
    `Draft a Korean invitation email to invite a customer to join a Customer Advisory Board (CAB). Use 합쇼체. 영광스러운 초대 톤이지만 부담은 적게 — 시간 약속을 분명히. Markdown sections: '**제목**' (1줄, 30자 이내 — '[고객사] [이름]님께 — Customer Advisory Board 초대' 류), '**본문**' (5 단락: 1) 짧은 인사 + '귀사를 우리 Customer Advisory Board의 첫 멤버 중 한 분으로 모시고 싶어 연락드립니다' + 왜 이분인지 1줄 (구체적 — '귀사의 X 사용 방식이 우리에게 큰 통찰이었어요'), 2) CAB이 무엇인지 — 보통 3-4 단락보다 짧게 — '분기 1회 1시간 미팅 + 신기능 베타 우선 액세스 + 우리 로드맵에 영향'), 3) 시간 약속 — '분기 1회 60분 미팅 / 가끔 짧은 설문 5분 — 1년 commit', 4) 받을 가치 — 신기능 우선 / 우리 임원 직접 접근 / 동종업계 다른 CAB 멤버 네트워킹 / 분기 1회 만찬 등 (입력에 맞춰), 5) 다음 단계 — '관심 있으시면 15분 통화로 더 설명드릴게요'), '**기간 / 종료**' (1줄 — '1년 시범 운영 후 양측 의향 확인').\n\n고객 / 프로그램 컨텍스트:\n${text}`,
  translate_pt_to_ko: (text) =>
    `Translate the Portuguese text below into natural Korean. 포르투갈어의 풍부한 동사 활용과 감정적 뉘앙스를 한국어로 자연스럽게 옮기되 직역 금지. 격식 톤은 원문에 맞춤 ('senhor/a' / 'você' 격식 → 해요체 또는 합쇼체 / 'tu' 친근 → 반말). 브라질 vs 포르투갈 포르투갈어의 어휘 차이는 입력 맥락에서 추론, 한국어 번역은 표준 한국어로. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 감정 / 뉘앙스 의역 1가지, 2) 한국어에 정확한 대응이 없는 표현 1가지와 처리, 3) 지역적 변종 추론과 번역 결정 1가지).\n\n원문 (Português):\n${text}`,
  ml_experiment_writeup_ko: (text) =>
    `Write a Korean ML experiment writeup from the run notes below. Use 합쇼체. Markdown sections: '**한 줄 결론**' (1줄 — 'A baseline 대비 X 메트릭이 Y%p 개선 / 실패 / 무변화'), '**가설**' (2-3줄 — 이 실험으로 검증하려던 가설을 평이한 말로), '**Setup**' (테이블 — '항목 | 값' — 모델 / 데이터셋 / 학습 hyperparameter / hardware / seed / 학습 시간), '**평가**' (테이블 — '메트릭 | Baseline | 실험 | Δ | 유의성 (CI 또는 p)'. 가능하면 신뢰구간 포함), '**Ablation / 살펴본 변형**' (있으면 bullets — 각 1줄 + 결과 한 줄), '**Failure modes**' (2-3 bullets — 모델이 망친 케이스 종류와 가능한 원인), '**해석**' (1-2 단락 — 왜 이런 결과가 나왔는지 우리 가설), '**다음 실험 후보 3가지**' (numbered — 가장 큰 정보 가치 기준으로 우선순위 + 1줄 이유), '**Repro / artifacts**' (bullets — 실험 ID / 데이터셋 hash / 모델 weight 경로 / 코드 SHA placeholder).\n\n실험 노트:\n${text}`,
  ai_prompt_template_ko: (text) =>
    `Design a structured AI prompt template (한국어 출력용) for the task below. The template should be production-ready, reusable, with named variables. Markdown sections: '**Task name**' (1줄 — kebab-case), '**Inputs (variables)**' (bullets — 각 변수 \`{name}\` + 1줄 설명 + 예시 1줄), '**System prompt**' (코드 블록 — 모델에 역할 부여, 출력 톤 / 형식 / 제약 명시. 한국어 출력이라면 '해요체' 같은 톤 명시), '**User prompt template**' (코드 블록 — 변수 placeholder 포함된 실제 사용자 메시지 형태), '**Expected output shape**' (코드 블록 또는 markdown — 모델이 따라야 할 구조), '**Few-shot 예시 (2-3개)**' (각 '### Example N' + 'Input' + 'Output' — 다양한 케이스 커버), '**Failure modes & guardrails**' (bullets — 모델이 흔히 빠지는 함정 + 우리가 prompt에 어떻게 막았는지), '**Test cases (3-5개)**' (bullets — 이 prompt가 production 가기 전 통과해야 할 케이스).\n\n태스크 설명:\n${text}`,
  exit_interview_questions_ko: (text) =>
    `Build a Korean exit interview question set for a departing employee in the role described below. Use 해요체. 솔직한 답을 끌어내되 방어적 / 비난적 분위기 만들지 않게 — 이미 떠나기로 한 사람의 시간을 존중. Markdown sections: '**인터뷰 진행 가이드 (1단락)**' (3-4줄 — 누가 진행하면 좋은지 (직속 매니저 X, HR or skip-level 권장) / 녹음 여부 / 응답 익명화 / 결과가 어디로 가는지), '**Warm-up 질문 (2개)**' (가벼운, 답하기 쉬운), '**Core 질문 (8-10개)**' (각 1줄 — 다음 영역 골고루: 1) 떠나는 결정의 진짜 이유, 2) 무엇이 떠나기로 결정한 순간이었는지, 3) 무엇이 바뀌었다면 남았을지, 4) 매니저 / 팀 관계, 5) 일 자체 / 영향력, 6) 보상 / 성장, 7) 회사 문화 / 가치, 8) 우리가 다음 사람에게 더 잘해주려면). 모두 열린 질문, 'why', 'how' 시작 — yes/no 금지, 9) '회사에 한 가지만 바꿀 수 있다면', 10) 이 사람을 어떤 환경에 추천하고 싶은지), '**Close 질문 (2개)**' (좋았던 것 1가지 + 우리에게 추천할 사람 / 다음 만남 의향), '**진행자 메모 가이드**' (3 bullets — 답을 평가하지 말 것 / 침묵 견디기 / 후속 질문 'tell me more about that').\n\n역할 / 맥락:\n${text}`,
  marketing_email_segments_3_ko: (text) =>
    `Take the marketing email below and write 3 segment-tailored Korean variants. Use 해요체. Format: '### Segment N — [세그먼트 이름]' followed by '**제목**' (1줄, 24자 이내) + '**프리헤더**' (1줄, 80자 이내) + '**본문 (3-4 단락)**' — 각 단락에 그 세그먼트가 가장 신경 쓰는 가치 / 두려움 / 언어를 반영 + '**CTA**' (1줄). 세그먼트는 입력의 제품 / 청중에 맞춰 가장 의미 있는 3개를 직접 정의 (예시: 'Power user — 새 기능 빠르게 시도하는 사람' / 'Pricing-sensitive — 가격에 민감한 신규 사용자' / 'Enterprise admin — 팀 도입 결정자'). 끝에 '**Personalization 자리**' (bullets — 각 variant에 \`{first_name}\`, \`{plan}\`, \`{last_active}\` 같은 토큰을 어디에 어떻게 끼울지) + '**Send-time 권장**' (각 세그먼트별 발송 시간대 + 이유 1줄).\n\n원본 메일 / 청중 컨텍스트:\n${text}`,
  client_kickoff_email_ko: (text) =>
    `Draft a Korean client kickoff email — sent the day a new client contract is signed. Use 합쇼체. 따뜻하게 환영 + 명확하게 다음 단계. Markdown sections: '**제목**' (1줄, 25자 이내 — '[고객사] 프로젝트 시작 안내 — [프로젝트명]' 류), '**본문**' (5 단락: 1) 정식 환영 + '계약을 마무리하셨고 우리는 [날짜]부터 시작합니다' 1줄, 2) 양측 핵심 인물 소개 — 우리 측 PM / 디자이너 / 엔지니어 + 고객 측 카운터파트 — 짧게 1줄씩, 3) 일정 한 줄 요약 + 다음 마일스톤 1가지 + 다음 회의 일정, 4) 협업 방식 — Slack 채널 / 문서 위치 / 미팅 리듬 / 응답 약속 시간 (예: '평일 4시간 안에 답변'), 5) 첫 주에 우리가 필요로 할 것 — 자료 / 접근권한 / 인터뷰 일정 등 명확히), '**P.S.**' (1줄 — 인간적인 한 마디 — '시작 전에 궁금하신 것 편하게 답장 주세요').\n\n프로젝트 / 고객 컨텍스트:\n${text}`,
  team_retro_facilitation_ko: (text) =>
    `Design a 60-minute Korean team retrospective facilitation plan for the sprint / period described below. Use 해요체. Markdown sections: '**Retro 목표 (1줄)**' (1줄 — '이 60분이 끝나면 우리는 구체적 액션 N개를 합의한다'), '**준비물 + 사전 작업**' (bullets — 화이트보드 / Miro 보드 / 사전 설문 / 데이터 차트 준비), '**아젠다 (테이블)**' (컬럼: '시간 | 활동 | 진행자 | 산출물'. 권장 골격: 0-5분 체크인 (한 단어로 이번 스프린트 느낌), 5-20분 데이터 + 사실 공유 (메트릭 / 사건 타임라인), 20-35분 발산 — 무엇이 잘됐나 / 안됐나 / 더 해보고 싶나 (개인 포스트잇 → 클러스터링), 35-50분 5whys로 핵심 패턴 1-2개 파고들기, 50-58분 액션 합의 — SMART 형식 (담당자 + 마감 명시) + 다음 retro에 점검, 58-60분 닫는 한 마디 — 한 단어 체크아웃), '**퍼실 가이드**' (3 bullets — 발언 균형 / 비난 vs 패턴 구분 / Last person speaks first rule 등), '**Action item 캡처 템플릿**' (1줄 — '#X — [액션] — @담당자 — 마감 YYYY-MM-DD — 검증: ...').\n\n스프린트 / 팀 컨텍스트:\n${text}`,
  design_critique_template_ko: (text) =>
    `Build a Korean design critique template for the design being reviewed below. Use 해요체. 비난이 아니라 설계 의도를 명료히 하고 다음 결정을 도와주는 형식. Markdown sections: '**리뷰 컨텍스트 (1단락)**' (2-3줄 — 이 디자인은 무엇을 위한 것인지 / 누구를 위한 것인지 / 단계 (탐색 / 시각화 / 완성형) — 디자이너가 채움), '**리뷰 진행 가이드**' (bullets — 디자이너가 5분 컨텍스트 → 10분 침묵 관찰 → 15분 질문 / 피드백 / 5분 결정 — 비난 톤 금지, '의도가 무엇이었나요' 질문 우선), '**피드백 구조 (각 평가자가 채움)**' — '### 평가자 N' followed by '**보고 느낀 첫인상 1줄**', '**잘 작동한다고 본 부분 2개**' (bullets — 무엇이 / 왜), '**의도가 헷갈렸던 부분 2개**' (bullets — 무엇이 / 어떻게 헷갈렸는지 — 단정 금지, 설명 요청 형식), '**제안하기 전 가진 질문 2개**' (bullets — 디자이너의 컨텍스트 / 제약을 더 알아야 답할 수 있는 것), '**대안 / 변형 1개**' (1줄 — 작은 변경 제안, 통째로 다시 그리지 말기). 끝에 '**합의된 다음 단계 (3 bullets)**' — 디자이너가 다음에 무엇을 / 언제까지 / 누구와 다시 볼지.\n\n디자인 / 리뷰 컨텍스트:\n${text}`,
  translate_it_to_ko: (text) =>
    `Translate the Italian text below into natural Korean. 이탈리아어 특유의 화려한 동사 활용과 감정 표현을 한국어로 자연스럽게 옮기되 직역 금지. 격식은 원문 톤에 맞춤 ('Lei' 격식 → 해요체 또는 합쇼체 / 'tu' 친근 → 반말). 이탈리아어의 비즈니스 / 학술 관용구는 한국어 자연스러운 표현으로 의역, 정확한 1대1 대응 없는 단어는 의역 + 1줄 노트. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 의역한 화려한 표현 1가지, 2) 한국어에서 어색해질 수 있던 부분과 처리, 3) 한자어 vs 고유어 선택 1가지).\n\n원문 (Italiano):\n${text}`,
  open_letter_to_community_ko: (text) =>
    `Draft a Korean open letter from a founder / CEO to a community (customers, users, contributors) about a major change, mistake, or commitment. Use 해요체. 솔직하고 인간적으로 — 마케팅 톤 / 변호사 톤 / 회피 톤 절대 금지. 글 전체 1000자 이내. Markdown sections: '**제목**' (1줄, 25자 이내 — '[커뮤니티명]에 드리는 편지' 류 직설적이되 격식), '**오프닝 (1단락)**' (3-4줄 — 누구로서 / 무엇 때문에 / 왜 직접 쓰는지 — 다른 사람한테 시키지 않고 내가 쓰는 이유), '**무슨 일이 있었나 / 무엇이 바뀌나 (1-2 단락)**' (사실을 평이한 한국어로, 'leverage', 'pivot' 같은 비즈니스 jargon 금지), '**책임 인정 (사과가 필요한 경우만, 1-2줄)**' ('죄송합니다' 정확히 한 번 — 변명 금지), '**우리가 다음에 할 것 (3 bullets)**' (구체적 — 'X를 Y월까지 하겠습니다' 형태 + 책임자), '**커뮤니티에 부탁**' (1-2줄 — 우리가 모르는 것 / 도움이 필요한 것), '**서명**' (1줄 — 이름 + 직책 / 회사).\n\n상황 / 메시지 컨텍스트:\n${text}`,
  tweetstorm_8_ko: (text) =>
    `Convert the idea below into a Korean tweetstorm of exactly 8 tweets. Use 해요체. Format each tweet as 'N/8: ...' on a new line, separated by blank lines. 각 tweet은 280자 한국어 기준 90자 이내. Structure: 1/8 hook (의외의 주장 또는 도발적 질문), 2/8 페인 또는 문제, 3/8 흔한 해결 시도 + 왜 부족한가, 4/8 핵심 통찰 또는 우리 접근, 5/8 구체적 예시 1개 (이야기 / 데이터 / 인용), 6/8 더 깊은 통찰 또는 메커니즘, 7/8 일반화 — 독자가 자기 상황에 적용하는 법, 8/8 클로징 (한 줄 호소 + CTA — 'RT' 부탁 금지, 'reply with your X' 류). 마지막에 '**Thread 메타**' (2 bullets — 1) 어떤 청중을 의도했는지, 2) follow-up tweet 1개 후보 — 누가 답글 달면 무엇을 더 풀어낼지).\n\n아이디어 / 원천:\n${text}`,
  translate_ko_to_vietnamese: (text) =>
    `Translate the Korean text below into natural Vietnamese (tiếng Việt). 베트남어의 어순 (SVO, 형용사 후치) 과 분류사 (con, cái, chiếc 등) 적절히 사용. 격식 톤은 원문에 맞춤 (한국어 해요체 / 합쇼체 → 베트남어 'anh / chị / quý vị' 호칭 + 'ạ' 어말 추가 / 반말 → 'em / cậu' + 무 어말). 한국식 외래어 / 한자어는 베트남에서 통용되는 표현으로 의역. Reply with two sections: '**Bản dịch**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 호칭 / 격식 결정 1가지, 2) 한국어 한자어 → 베트남어 의역 1가지, 3) 베트남어 어순 재배치 1가지).\n\n원문 (한국어):\n${text}`,
  data_request_email_ko: (text) =>
    `Draft a Korean email requesting data / a dataset from another team (data team, ops, partner company). Use 합쇼체. 명확하고 정중하게 — 무엇을 / 왜 / 언제까지 / 어떤 포맷으로. 상대가 '얼마나 걸릴지' 즉시 가늠할 수 있게. Markdown sections: '**제목**' (1줄, 30자 이내 — '[데이터 종류] 데이터 요청 — 마감 YYYY-MM-DD' 류), '**본문**' (5 단락: 1) 짧은 인사 + 한 줄 컨텍스트 — '[프로젝트명] 진행 중인데 데이터 도움이 필요합니다', 2) 무엇이 필요한지 — 정확히: 테이블명 / 컬럼 / 기간 / 필터 조건 / row 추정치, 3) 왜 필요한지 — 1-2줄, 이 데이터로 답할 질문 명시, 4) 형식 + 전달 방법 — CSV / Parquet / S3 / 직접 Snowflake 권한 등 옵션 + 선호도, 5) 마감 — 'YYYY-MM-DD까지 부탁드립니다 / 일정 어려우면 가능 시점 알려주세요'), '**민감 정보 처리**' (1줄 — PII / 마스킹 필요 여부 + 우리 측 보관 정책 + 작업 후 폐기 약속), '**다음 단계 / 문의**' (1줄 — 못 만나는 조건 / 추가 컨텍스트 필요 시 누구한테).\n\n데이터 / 프로젝트 컨텍스트:\n${text}`,
  all_hands_speech_ko: (text) =>
    `Write a Korean all-hands speech script (15분 분량) from the company update notes below. 화자는 CEO 또는 본부장. Use 합쇼체. 진정성 + 명확함 — 마케팅 톤 / 빈말 / 무한 감사 금지. Markdown structure per section: '### Section N (MM:SS-MM:SS) — [섹션 이름]' followed by '**Talking points**' (3-5 bullets in 합쇼체, 화자가 정리한 노트) and '**예상 슬라이드**' (1줄 — 화면에 보일 것). 권장 구성: Section 1 (0-2분) 오프닝 — 이번 분기 한 줄 + 분위기, Section 2 (2-5분) 핵심 결과 3가지 — 데이터 + 인간 이야기 1개씩, Section 3 (5-9분) 안 된 것 / 어려웠던 것 — 솔직히 + 우리 학습, Section 4 (9-12분) 다음 분기 베팅 — 어디에 집중하고 무엇은 안 할지, Section 5 (12-14분) 사람 인정 — 호명 + 구체적 한 일 — 가짜 이름 안 만듦, Section 6 (14-15분) 클로징 + Q&A 안내. 끝에 '**발표자 호흡 메모**' (3 bullets — 어디서 잠시 멈출지 / 어디서 시선 들어올릴지 / 어떤 단어를 강조).\n\n분기 데이터 + 메모:\n${text}`,
  investor_data_room_index_ko: (text) =>
    `Build a Korean data room index for an investor due diligence. Use 합쇼체. Markdown structure: '### 1. Corporate' followed by bullets (정관 / 주주명부 / 등기부등본 / 이사회의록 — 각 항목 '문서명 — 최신 일자 — 담당자' 형식 placeholder), '### 2. Financial' (재무제표 3년 / 월별 P&L / cap table / 매출 detail / runway model), '### 3. Product' (로드맵 / 기술 스택 / 아키텍처 다이어그램 / IP 목록), '### 4. Sales & Marketing' (매출 by customer / pipeline / cohort retention / unit economics / channel cost), '### 5. Team & Org' (조직도 / key person 이력 / option pool / 채용 plan), '### 6. Legal' (주요 계약 — 고객 / 공급사 / 노동 / 라이선스 / 분쟁 — '없음 명시' 권장), '### 7. Customer' (top 10 고객 / 계약 / 인터뷰 / NPS / reference 후보 명단), '### 8. Compliance' (개인정보 처리방침 / 보안 정책 / GDPR / SOC2 진행 상태). 끝에 '**관리 가이드 (3 bullets)**' — 1) 폴더별 권한 설정 권장, 2) 추적해야 할 access log, 3) 업데이트 cadence + 책임자).\n\n회사 / 라운드 컨텍스트:\n${text}`,
  patent_disclosure_summary_ko: (text) =>
    `Compress the technical invention disclosure below into a Korean patent disclosure summary suitable for handoff to a patent attorney. Use 합쇼체, 정확하고 간결하게 — 발명의 본질을 흐릴 수 있는 마케팅 톤 금지. Markdown sections: '**발명 한 줄**' (1줄 — 무엇을 / 무엇과 다르게 / 무엇이 가능해지는지), '**기술 분야**' (1줄 — 분류 + 응용 분야), '**해결하는 문제**' (2-3줄 — 종래 기술의 한계, 가능하면 구체적 예 1개), '**핵심 발명 요소 (Independent claim 후보)**' (numbered — 1-3개 핵심 청구 요소를 사람 말로 — 각 1-2줄, 'A를 B하는 방법으로서, C를 포함하는 것을 특징으로 하는' 류 청구항 어투 미리 갖춤), '**구체적 구현 예 (Embodiment)**' (1-2 단락 — 가능한 구현 1-2개 / 변형 가능성 포함), '**선행 기술 인용 (Prior art)**' (bullets — 알고 있는 유사 특허 / 논문 / 제품 — 각 '인용 + 우리 발명이 어떻게 다른지 1줄'. 없으면 '검색 미실시'), '**상업적 가치 / 우회 가능성**' (2 bullets — 누가 이 특허를 회피하려면 무엇을 해야 할까), '**Inventor 정보**' (bullets — 이름 / 소속 / 발명 기여도). 끝에 '**다음 단계 (변호사 검토 전 체크)**' (3 bullets — 공개 일자 / 우선권 / inventor 동의 서명).\n\n발명 설명:\n${text}`,
  translate_ko_to_thai: (text) =>
    `Translate the Korean text below into natural Thai (ภาษาไทย). 태국어의 호칭 / 격식 시스템 (ครับ / ค่ะ / ขอรับ — speaker gender 추론 필요) 반영 — 입력에 화자 성별 단서 없으면 중립적인 형식으로 표시. 한국어 한자어 / 외래어는 태국에서 통용되는 표현으로 의역, 정확한 대응 없으면 영어 외래어 + 태국어 음역 + 1줄 노트. 격식은 원문에 맞춤 (해요체 → 정중 / 합쇼체 → 더 정중 + ขอรับ / 반말 → 친근). Reply with two sections: '**คำแปล**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 호칭 / 격식 결정 1가지, 2) 정확한 대응 없는 단어와 처리 1가지, 3) 태국어 문화 컨텍스트 고려한 의역 1가지).\n\n원문 (한국어):\n${text}`,
  youtube_metadata_ko: (text) =>
    `Generate a complete Korean YouTube metadata pack for the video described below. Use 해요체. Markdown sections: '**제목 (3 variants)**' (각 50자 이내 한국어 YT 검색 의식 — 1) 호기심 자극형, 2) 검색 키워드 명확형, 3) 결과 약속형 — 각 variant에 '의도 1줄' 짧게), '**설명 (Description)**' (전체 1500자 이내 한국어 — 첫 2줄에 후크 + 핵심 약속 / 챕터 타임스탬프 코드 블록 / 영상에서 언급한 자료 링크 placeholder / 채널 다른 영상 2-3개 placeholder / 소셜 / CTA), '**태그 (15개 이내)**' (쉼표 구분 1줄 — 한국어 + 영어 섞기, 너무 일반적인 것 피하기), '**썸네일 카피 (3 variants)**' (각 8자 이내, 큰 글자로 화면에 들어갈 표현 — '대놓고 비교!' 류 어그로 vs 'X 만에 Y하기' 류 정보형 vs '진짜 이유는?' 류 호기심), '**Pinned comment 후보**' (1줄 — 영상 보고 첫 액션할 사람에게 가볍게 던지는 질문).\n\n영상 컨텍스트:\n${text}`,
  office_hours_email_ko: (text) =>
    `Draft a Korean email announcing recurring 'office hours' — a regular open slot for customers / community / colleagues to drop in. Use 해요체, 친근 + 명확. Markdown sections: '**제목**' (1줄, 25자 이내 — '[본인 / 팀] Office Hours 시작 안내' 류), '**본문**' (4 단락: 1) 짧은 인사 + 'office hours를 매주 [요일] [시간] (KST) 열게 됐어요' — 시작 이유 1줄 (예: '여러분 질문 / 피드백을 직접 듣고 싶어서'), 2) 누가 와도 좋은지 — 대상 명확히 ('우리 제품 쓰는 분 / 검토 중인 분 / 비슷한 문제 푸는 분 누구나'), 3) 어떻게 진행되는지 — 30분 / Zoom / 신청 없이 드롭인 OR 사전 신청 — 형식 명확히, 4) 처음 몇 주 권장 주제 1-2개 + 'X 질문이면 더 도움될 수 있어요' 1줄), '**예약 / 참여 링크**' (1줄 — Calendar / Calendly / Zoom placeholder), '**P.S.**' (1줄 — 시간 안 맞으면 답장 부탁 + 비동기 질문도 환영).\n\n본인 / 청중 / 운영 컨텍스트:\n${text}`,
  annual_planning_one_pager_ko: (text) =>
    `Build a Korean annual company planning one-pager from the strategic inputs below. Use 합쇼체. Markdown sections: '**올해 한 줄 (Theme)**' (1줄 — '올해 우리는 [무엇을] [어디로]'), '**작년 한 줄 회고**' (1줄 — 가장 큰 배움), '**올해 우리가 풀려는 문제 3가지**' (numbered — 각 'Problem 한 줄' + '왜 지금' 한 줄), '**Pillars 3-4개**' (각 'h3: Pillar 이름' + '책임자' + '연말 결과 1줄 — 측정 가능' + '핵심 위험 1줄'), '**숫자 — 회사 KPI**' (bullets — 3-5개 — 'KPI: 현재 X → 연말 목표 Y'), '**우리가 일부러 안 할 것 (No-list)**' (3 bullets — 거절할 기회 — 시장 / 기능 / 사업 모델), '**의존성 / 가정**' (3 bullets — 이 계획이 깨질 조건), '**Review cadence**' (1줄 — 분기 1회 / 월간 metric check / 어떤 트리거에 재계획).\n\n전략 입력 / 작년 데이터:\n${text}`,
  video_thumbnail_text_3_ko: (text) =>
    `Generate 3 Korean YouTube thumbnail text variants for the video described below. 썸네일은 모바일 작은 화면에서도 읽혀야 하니 큰 글자 / 짧은 어구. Use 해요체 (또는 명사형). Format: '### Variant N — [각도명]' followed by '**메인 텍스트 (Big text)**' (1줄, 6자 이내 — 화면 60% 차지할 큰 글자), '**보조 텍스트 (Sub)**' (1줄, 10자 이내 — 메인 보완), '**색상 / 디자인 힌트**' (1줄 — 추천 배경색 / 액센트 / 본인 얼굴 표정 1단어). 각도: 1) **호기심형** ('진짜 이유는?'), 2) **결과 약속형** ('30분만에' / '하루에 1번'), 3) **충격 / 의외형** ('절대 X 하지 마세요'). 끝에 '**테스트 권고**' (2 bullets — 1) CTR 측정 기준 (영상 첫 시간 CTR), 2) variant 사이 차이가 의미 있으려면 N회 노출 이상 필요).\n\n영상 / 채널 컨텍스트:\n${text}`,
  translate_ko_to_russian: (text) =>
    `Translate the Korean text below into natural Russian (русский язык). 러시아어의 성 (gender), 격 (case), 동사상 (perfective / imperfective)을 정확히 사용. 격식은 원문에 맞춤 (한국어 해요체 / 합쇼체 → 'вы' + 정중체 / 반말 → 'ты' + 친근체). 한국어 한자어 / 외래어는 러시아에서 통용되는 표현으로 의역, 정확한 대응 없으면 영어 외래어 + 키릴 음역 + 1줄 노트. Reply with two sections: '**Перевод**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격 / 성 결정 1가지, 2) 동사상 선택 1가지, 3) 의역한 표현 1가지).\n\n원문 (한국어):\n${text}`,
  incident_war_room_intro_ko: (text) =>
    `Write a Korean kickoff message to open an incident war-room — sent the moment a Sev1/2 incident is declared, posted to a dedicated Slack channel. Use 합쇼체. 5초 안에 모든 참여자가 자기 역할 / 다음 액션을 알 수 있게. Markdown sections: '**1줄 상태**' (1줄 — '🚨 Sev[X] 선언 — [한 줄 영향] — IM: @이름'), '**핵심 사실**' (bullets — 시작 시각 / 감지 신호 / 추정 영향 (사용자 / 매출) / 현재 상태 — 모르면 'TBD'), '**역할 (Roles)**' (bullets — 'IM (Incident Manager): @이름' / 'CL (Communications Lead): @이름' / 'OL (Ops Lead): @이름' / 'SME: @이름' — 모르면 '필요' 마킹), '**바로 부탁드리는 것**' (numbered — 1) 데이터 / 로그 / 그래프 어디로 / 누가 가져올지, 2) 외부 커뮤니케이션 누가 / 언제 첫 status page 업데이트, 3) 임시 완화 candidate — 누가 결정), '**다음 체크인**' (1줄 — 'HH:MM 또는 +15분 후 — 진척 없으면 escalation'), '**채널 규칙**' (3 bullets — 결정만 이 채널 / 디버깅은 thread / @here 자제). 끝에 '**전체 사후 보고서 책임자**' (1줄 — IM이 default, 다르면 명시).\n\n장애 컨텍스트:\n${text}`,
  marketing_one_pager_partner_ko: (text) =>
    `Build a Korean marketing one-pager for a partnership pitch — sent to a potential partner to argue why joint marketing makes sense. Use 합쇼체. Markdown sections: '**제목 (Header)**' (1줄 — '[Our Co] × [Their Co] — 협업 제안 1페이지'), '**한 줄 약속**' (1줄 — 양사가 함께 무엇을 만들면 누구한테 어떤 가치가 가는지), '**우리 (1단락)**' (3-4줄 — 누구 / 어떤 청중 / 어떤 자산 — 가능하면 수치 1개), '**상대 (1단락)**' (3-4줄 — 상대 회사를 우리 이해로 — 마치 본인 회사처럼 자세히, 그쪽의 가치를 우리가 봐 줬다는 신호), '**겹치는 청중 (Overlap)**' (1-2줄 + 수치 — '두 회사 사용자의 X%가 같은 페르소나' 또는 '관심 분야 겹침 추정 N만 명'), '**제안하는 협업 형태 3가지**' (각 'Option N — 형식 (공동 웹세미나 / 공동 콘텐츠 / 공동 캠페인) — 각자 책임 + 예상 임팩트 + 일정'), '**우리가 가져갈 것 / 그쪽이 가져갈 것**' (2 컬럼 markdown — 솔직하게 양쪽 ROI 명시), '**다음 단계**' (1줄 — '관심 있으시면 30분 통화 + 그 후 1주일 내 짧은 MOU') + 문의처.\n\n양사 / 협업 컨텍스트:\n${text}`,
  translate_ru_to_ko: (text) =>
    `Translate the Russian text below into natural Korean. 러시아어의 격 / 동사상 / 분사 / 부사구문을 한국어 어순에 맞게 재구성, 직역 금지. 격식은 원문 톤에 맞춤 ('Вы' → 해요체 또는 합쇼체 / 'ты' → 반말). 러시아어 비즈니스 / 학술 관용구는 한국어 자연스러운 표현으로 의역, 정확한 1대1 대응 없으면 의역 + 1줄 노트. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 긴 부사구문 → 한국식 절 재구성 1가지, 2) 의역한 표현 1가지, 3) 동사상 (perfective vs imperfective) 한국어 처리 1가지).\n\n원문 (Русский):\n${text}`,
  feature_specification_short_ko: (text) =>
    `Write a short Korean feature spec (1-2 page) for the feature described below. Use 해요체. Markdown sections: '**한 줄 (TL;DR)**' (1줄 — 누가 / 무엇을 / 왜), '**문제 / Why now**' (2-3줄 — 사용자가 지금 어떻게 막혀 있는지 + 이 분기에 풀려는 이유), '**Goal & Non-goals**' (2개 bullets 그룹: Goal 3개 — 측정 가능, Non-goal 3개 — 의식적으로 안 하는 것), '**페르소나 + 핵심 user story**' (1단락 + 'As a [persona], I want to [action], so that [outcome]' 형식 1-2개), '**핵심 UX 흐름**' (numbered — 4-6 단계, 각 단계 1줄 — 와이어프레임 자리 placeholder), '**기술 / 데이터 노트**' (bullets — 새 API / 새 테이블 / 의존성 / latency 목표 / 마이그레이션 필요 여부 — 깊이 있게가 아니라 헤드라인만), '**메트릭**' (bullets — 출시 후 추적할 1-3 KPI + baseline / target / 측정 방법), '**Open questions**' (3 bullets — 답이 필요한 것 + 누가 / 언제까지 답할지), '**일정 (대략)**' (1-2줄 — 디자인 / 빌드 / 베타 / 정식 출시 — 주차 단위).\n\n기능 컨텍스트:\n${text}`,
  talent_referral_email_ko: (text) =>
    `Draft a Korean email asking a friend / connection to refer a strong candidate for an open role. Use 해요체, 친근하고 짧게. 부담은 적게. Markdown sections: '**제목**' (1줄, 22자 이내 — '[직군] 사람 한 명만 추천 부탁드려요' 류 작은 부탁 톤), '**본문**' (4 단락: 1) 짧은 안부 + 최근 그쪽 소식에서 본 구체적 1가지 reference, 2) 우리가 누구를 / 왜 찾는지 — 1-2줄, 채용 페이지 링크 placeholder, 3) 이 사람의 핵심 조건 3가지 — 너무 길어지면 부담, 좁고 정확하게 — '5년차 이상 / B2B SaaS 경험 / 한국 시장' 류, 4) 부탁 — '한 분 떠오르시면 가볍게 LinkedIn 보내주셔도 되고, 우리한테 그분 이름 알려주셔도 됩니다' — 소개 방식 선택권 주기 + '추천 보너스 N만원' 1줄), '**P.S.**' (1줄 — 본인이 그쪽한테 다음에 도와줄 수 있는 것 1가지 작게).\n\n포지션 / 회사 / 본인 컨텍스트:\n${text}`,
  translate_zh_to_ko: (text) =>
    `Translate the Mandarin Chinese text below into natural Korean. 중국어의 사자성어, 비유 표현, 4-6자 명사구를 한국어로 자연스럽게 옮기되 직역 금지. 격식 톤은 원문에 맞춤 (정중 → 합쇼체 / 일상 → 해요체 / 친근 → 반말). 중국어 한자어 중 한국에서 한자어 그대로 통용되는 것은 한자어 그대로, 안 쓰이는 것은 고유어로 의역. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 사자성어 / 비유 의역 1가지, 2) 한자어 vs 고유어 선택 1가지, 3) 중국 문화 컨텍스트 처리 1가지).\n\n원문 (中文):\n${text}`,
  press_followup_email_en: (text) =>
    `Write an English press follow-up email to a journalist 5-7 days after the original pitch went unanswered. Tight, not naggy. Markdown sections: '**Subject**' (1 line, under 50 characters — 'Following up: [original subject keyword]' or a fresh hook), '**Body**' (3 short paragraphs: 1) 1-line reference to the original send ('I sent over a note last week about X — sharing one new angle that might be interesting'), 2) one **new** piece of information they didn't have last time — a fresh data point, a quote from someone, an update — under 3 sentences, 3) easier ask than the first pitch — 'happy to send embargoed details or do a 10-minute call this week if useful'), '**Sign-off**' (1 line — name + 1 sentence credentials). After the email, '**Why this follow-up works (Korean)**' (3 bullets in Korean 해요체 — 1) 첫 피치를 반복하지 않고 새 정보 1개를 추가한 이유, 2) ask를 더 작게 만든 이유, 3) 이걸로도 답 없으면 그만둘지 한 번 더 시도할지 가이드).\n\nOriginal pitch + new angle:\n${text}`,
  investor_intro_round_close_ko: (text) =>
    `Write a Korean email to investors who are in late conversations, announcing that the round is about to close — the 'momentum email' or FOMO email. Use 합쇼체. 솔직 + 짧게, 가짜 어버지티 톤 금지. Markdown sections: '**제목**' (1줄, 24자 이내 — '[회사명] 라운드 마감 임박 안내' 류), '**본문**' (4 단락: 1) 짧은 인사 + '저희 라운드가 다음 [날짜]에 마감 예정이라 안내드립니다' 1줄, 2) 현재 라운드 상태 — '총 X억 / 이미 Y억 LOI / 남은 슬롯 N장' + 누가 commit했는지 (lead / co-lead 이름 — 동의받은 것만), 3) 진행 단계별 다음 액션 — '아직 검토 중이시면 — 이번 주 안에 미팅 한 번 더 잡을 수 있을지 알려주세요 / DD 자료 추가 필요하시면 24시간 안에 보내드립니다 / pass 결정하셨으면 짧게 1줄 회신 부탁드립니다', 4) 'pass도 OK입니다' 1줄 — 토라진 톤 절대 금지), '**P.S.**' (1줄 — 결정에 도움될 한 가지 새 정보 — 최근 1주 추가된 고객 / 메트릭 / 보도 등).\n\n라운드 / 투자자 컨텍스트:\n${text}`,
  translate_ar_to_ko: (text) =>
    `Translate the Arabic text below into natural Korean. 아랍어의 오른쪽-왼쪽 흐름과 풍부한 동의어 시스템을 한국어 어순으로 재구성, 직역 금지. 격식 톤은 원문에 맞춤 (Modern Standard Arabic 'فصحى' 정식 → 합쇼체 / 회화 / 방언 → 해요체 또는 반말). 아랍어 종교 / 문화 표현 ('إن شاء الله', 'الحمد لله' 등)은 맥락에 따라 의역 또는 한국어 자연스러운 표현으로. Reply with two sections: '**번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets — 1) 문화 / 종교 표현 의역 1가지, 2) 동의어 풍부함 → 한국어 한 단어 선택 1가지, 3) 어순 재배치 / 정관사 처리 1가지).\n\n원문 (العربية):\n${text}`,
  user_test_report_ko: (text) =>
    `Compress raw user test session notes (3-8 participants) into a Korean user test report. Use 해요체. Markdown sections: '**리서치 질문 (1줄)**' (1줄 — 이 테스트가 답하려 한 질문), '**Setup (1줄)**' (1줄 — N명 / 페르소나 / 어떤 task — 인터뷰 / 사용성 / 카드소트 등), '**핵심 발견 3-5개**' (각 '### 발견 N: [한 줄 결론]' + '근거' bullets — 3-5명 중 몇 명이 이 행동을 보였는지 + 짧은 인용 1개 — '> 참가자 N — "..."'), '**막힌 곳 / Friction**' (테이블 — 'Task | 막힌 % | 막힌 이유 | 심각도 (S/M/L)'), '**놀라움 (Insight)**' (2 bullets — 가설과 달랐던 행동), '**확신도 (낮음 / 중간 / 높음)**' (1줄 — 모수 / 다양성 / 재현성 기반 자기 평가), '**제안 (Recommendations)**' (numbered — 각 항목 '제안 1줄 + impact 1줄 + effort 1줄 + 우선순위'), '**Open questions (다음 테스트)**' (2 bullets — 이번엔 답 못 한 것).\n\n원본 노트:\n${text}`,
  release_notes_html_ko: (text) =>
    `Convert the Korean release-note bullets below into clean semantic HTML ready to paste into a /changelog page. Output ONLY the HTML, no markdown fences. Structure: '<article class="release">', '<header><h2>vX.Y.Z</h2><time datetime="YYYY-MM-DD">YYYY-MM-DD</time></header>' (버전 / 날짜 입력에서 추출), '<section class="highlights">' with '<h3>주요 변경</h3><ul><li>...</li></ul>' (이 릴리스의 marquee 변경 2-3개 — 풍부한 설명), then '<section class="changes">' with grouped lists: '<h3>새 기능</h3><ul>...</ul>', '<h3>개선</h3><ul>...</ul>', '<h3>버그 수정</h3><ul>...</ul>', '<h3>호환성</h3><ul>...</ul>' (해당 그룹만, 비어 있는 그룹 생략). 각 \`<li>\`는 명사형 한 줄 + 필요 시 \`<a>\` 링크 placeholder. 마지막에 '<footer><p>전체 변경사항은 <a href="">GitHub</a>에서 확인하세요.</p></footer>'.\n\n릴리스 노트:\n${text}`,
  ai_safety_eval_plan_ko: (text) =>
    `Build a Korean AI safety evaluation plan for the model / system below — pre-launch safety review. Use 합쇼체. Markdown sections: '**시스템 한 줄**' (1줄 — 무엇을 / 누구를 위해 / 어느 단계), '**평가 범위 (Scope)**' (bullets — 입력 형태 / 출력 형태 / 사용 컨텍스트 / 우리가 답하지 않으려는 외부 위험), '**위협 모델 (Threat model)**' (테이블 — '위협 카테고리 | 시나리오 | 잠재 피해 | 가능성 | 우선순위'. 카테고리: 잘못된 정보 / 유해 콘텐츠 / 차별 / 개인정보 노출 / 자해 조장 / 보안 / 법적 위반 / 오용), '**평가 방법론**' (각 위협마다 1-2 bullets — 자동 (red-team prompt set / classifier eval / adversarial probe) + 수동 (전문가 검토 / 사용자 IT)), '**Acceptance criteria**' (테이블 — '평가 | 임계값 | 측정 방법 | 실패 시 액션'), '**거버넌스**' (bullets — 누가 평가 결과 검토 / 누가 출시 결정 / 출시 후 모니터링 cadence + 트리거 — '특정 메트릭이 X로 떨어지면 즉시 중단'), '**문서 / 추적**' (2 bullets — 어디에 결과 기록 / 외부 공개 여부).\n\n모델 / 시스템 컨텍스트:\n${text}`,
  translate_ko_to_arabic: (text) =>
    `Translate the Korean text below into Modern Standard Arabic (الفصحى الحديثة). 격식 톤은 원문에 맞춤 (한국어 합쇼체 → 정중 정식체 + الفصحى / 해요체 → 다소 격식 정식체 / 반말 → 회화 톤 — 단, 회화 톤 요청 시 어느 방언이 적절한지 1줄 노트). 한국어 한자어는 아랍어에서 통용되는 표현으로 의역. 정확한 1대1 대응이 없는 단어는 의역 + 영어 외래어 + 1줄 노트. Reply with two sections: '**الترجمة**' (the translated text, RTL 자연스럽게, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격식 / 톤 결정 1가지, 2) 의역한 한자어 / 추상명사 1가지, 3) 아랍 문화 컨텍스트 고려 1가지).\n\n원문 (한국어):\n${text}`,
  demo_day_script_ko: (text) =>
    `Write a Korean 3-minute demo day pitch script (창업가가 무대에서 발표하는 형식). Use 해요체. Markdown structure per section: '### Section N (MM:SS-MM:SS) — [섹션]' followed by '**Slide**' (1줄 — 화면에 보이는 시각자료) and '**Spoken (script)**' (실제 발화, 따옴표 안에). 권장 구성: 0:00-0:15 Hook — 사용자 페인 한 줄로 청중 사로잡기, 0:15-0:35 우리 회사 한 줄 정의 + 솔루션 한 마디, 0:35-1:15 데모 — 가장 매혹적인 1개 use case 30초, 1:15-1:50 트랙션 — 가장 강한 메트릭 3개 (수치 명확히, '많이' 같은 형용사 금지), 1:50-2:20 시장 + Why now 1줄씩, 2:20-2:45 팀 — 핵심 인물 1-2명 + 우리만의 unfair advantage, 2:45-3:00 The ask — 라운드 / 채용 / 파트너십 중 1개만 명확히 + 'come talk to me at booth N'. 끝에 '**발표 메모**' (3 bullets — 톤 / 호흡 / 시선 처리).\n\n회사 / 발표 컨텍스트:\n${text}`,
  discord_announcement_ko: (text) =>
    `Draft a Korean Discord announcement post for a community server. Use 해요체. Discord 톤 — 친근, 이모지 적절히, 짧고 스캔 가능하게. Markdown sections: '**제목 (Embed title)**' (1줄, 30자 이내 — 핵심 이벤트 명사형 + 이모지 1개 prefix), '**한 줄 hook (Embed description 첫줄)**' (1줄 — 왜 지금 이걸 봐야 하는지), '**본문 (3-5 짧은 단락 또는 bullets)**' (각 1-2줄, 핵심 변경 / 이벤트 / 부탁 — 길어지면 thread로 나누라는 1줄 표시), '**핵심 사실 (📅 / 📍 / ⏰ 이모지 사용)**' (3-4 bullets — 날짜 / 장소 / 시간 / 누가 대상 — 정확히), '**다음 액션 (1줄)**' (1줄 — 'react with ✅ if joining' 류 작은 commit), '**관련 채널 / 링크 (Mentions)**' (bullets — \`#channel-name\` mention + 1줄 설명, role mention 'optionally @here / @everyone' 가이드 1줄 — 정말 모두가 봐야 할 때만 권장). 마지막에 'react with 💬 to ask anything' 1줄.\n\n발표 내용 / 커뮤니티:\n${text}`,
  compliance_questionnaire_ko: (text) =>
    `Generate a Korean response to a customer's security / compliance questionnaire (보통 enterprise 도입 시 받는 50-100문항). Use 합쇼체. 솔직하게 — 'No / Not yet / Partially / Yes'를 정확히 구분, 거짓 'Yes' 절대 금지. Output a markdown table format: '질문 | 답변 (Y/N/P/NY) | 우리 답변 1-2줄 | 증빙 자료'. 자주 나오는 질문 카테고리 자동 분류: 1) 데이터 암호화 (저장 / 전송 / 키 관리), 2) 접근 통제 (RBAC / SSO / MFA / 비밀번호 정책), 3) 데이터 보관 / 삭제 (retention / GDPR 삭제 요청), 4) 보안 인증 (SOC2 / ISO27001 / 침투 테스트), 5) 가용성 / SLA, 6) 사고 대응 (감지 / 통보 시간), 7) 하청 (subprocessor), 8) BCDR (백업 / 복구). 입력의 회사 단계에 맞춰 솔직 — 초기 스타트업이면 'SOC2 Type 1 진행 중 / Type 2는 내년 Q2 목표' 식 미래 commit과 함께. 끝에 '**답변 가이드 (3 bullets)**' — 1) 모르는 항목은 '확인 후 회신' 명시, 2) 'P' (Partial) 답변은 반드시 구체적 한계 명시, 3) 거짓 'Y'가 계약 후 발각되면 더 큰 비용.\n\n질문지 / 회사 컨텍스트:\n${text}`,
  translate_id_to_ko: (text) =>
    `Translate the Indonesian text below into natural Korean. 인도네시아어 (Bahasa Indonesia)의 어순 (대체로 SVO), 접두사 / 접미사 (ber-, ter-, -kan, -an), 명사 반복 복수형 (orang-orang)을 한국어 자연스러운 표현으로 옮기되 직역 금지. 격식 톤은 원문에 맞춤 ('Bapak / Ibu' 격식 → 합쇼체 / 'Anda' 정중 → 해요체 / 'kamu' 친근 → 반말). 인도네시아어의 영어 외래어는 한국에서 통용되는 표현으로. Reply with two sections: '**Terjemahan / 번역**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 접두사 / 접미사 의미 처리 1가지, 2) 명사 반복 → 한국어 복수 처리 1가지, 3) 의역한 표현 1가지).\n\n원문 (Bahasa Indonesia):\n${text}`,
  growth_experiment_log_ko: (text) =>
    `Build a Korean growth experiment log entry from the experiment notes below. Use 해요체. Markdown sections: '**Experiment ID + 제목**' (1줄 — 'EXP-NNN — [짧은 제목]'), '**가설**' (1줄 — '우리는 [변경]을 하면 [메트릭]이 [방향으로] 움직일 것이다, 왜냐하면 [메커니즘]'), '**대상 (Audience)**' (1줄 — 누구에게 / 트래픽 분배 — 50/50 또는 90/10), '**기간**' (1줄 — 시작 ~ 종료 + 최소 N일 보장 이유), '**메트릭**' (테이블 — 'Metric | Type (primary/guardrail) | Baseline | Target | 실제 결과 | 유의성 (p / CI)'), '**결과 한 줄**' (1줄 — 'WIN / NO-WIN / INCONCLUSIVE + 1줄 해석'), '**놀라움**' (1줄 — 가설과 다르게 움직인 것 1가지), '**다음 결정**' (1줄 — 'ship to 100% / iterate / kill / rerun longer'), '**다음 가설 후보**' (2 bullets — 이번 결과에서 자연스럽게 따라오는 후속 실험).\n\n실험 노트:\n${text}`,
  translate_ko_to_indonesian: (text) =>
    `Translate the Korean text below into natural Indonesian (Bahasa Indonesia). 인도네시아어의 격식 시스템 ('Anda' 정중 / 'kamu' 친근 / 'lo / lu' 캐주얼), 접두사 / 접미사 (me-, ber-, -kan), 명사 반복 복수형 (orang-orang)을 자연스럽게 사용. 한국어 한자어 / 외래어는 인도네시아에서 통용되는 표현 또는 영어 외래어로. 격식은 원문 톤에 맞춤 (합쇼체 → 'Anda' + 정중 / 해요체 → 'Anda' 또는 'kamu' / 반말 → 'kamu' 또는 'lo'). Reply with two sections: '**Terjemahan**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격식 / 호칭 결정 1가지, 2) 접두사 / 접미사 의미 처리 1가지, 3) 의역한 표현 1가지).\n\n원문 (한국어):\n${text}`,
  user_journey_map_storyboard_ko: (text) =>
    `Turn the user scenario below into a Korean storyboard-style user journey (시각적 그림 6컷). Use 해요체. Markdown structure per panel: '### Panel N — [장면명] (감정: 😀 / 🙂 / 😐 / 😟 / 😡)' followed by '**Visual (한 줄 묘사)**' (1줄 — 그림으로 그렸을 때 화면에 무엇이 보일지 — 인물 / 화면 / 배경), '**Action (1줄)**' (사용자가 무엇을 하는지 — 동사로 시작), '**Thought (1줄)**' (생각풍선 안에 들어갈 한 마디 — 따옴표 안에), '**Touchpoint**' (1줄 — 어떤 우리 접점이 이 순간에 있나 — 앱 / 이메일 / 사람 / 없음), '**Quote 후보**' (1줄 — 사용자 실제 발언처럼 들리는 1줄 — 인터뷰 인용 자리). 6컷 흐름: Trigger → 인식 → 첫 시도 → 막힘 / 발견 → 해결 → 결과. 끝에 '**시사점 3가지**' (numbered — 어느 panel에 무엇을 개선하면 가장 큰 효과인지).\n\n시나리오 / 페르소나:\n${text}`,
  translate_ko_to_german: (text) =>
    `Translate the Korean text below into natural German (Deutsch). 독일어의 격 (Nominativ / Akkusativ / Dativ / Genitiv), 성 (m/f/n), 동사 후치 규칙을 정확히 적용. 격식은 원문에 맞춤 (한국어 합쇼체 → 'Sie' + 정중 / 해요체 → 'Sie' / 반말 → 'du'). 한국어 한자어는 독일어 자연스러운 명사로 의역, 정확한 1대1 대응이 없으면 합성 명사 (Komposita)로 만들거나 의역 + 1줄 노트. Reply with two sections: '**Übersetzung**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격 결정 1가지 (왜 Akkusativ인지 등), 2) 합성 명사 만든 것 1가지, 3) 의역한 표현 1가지).\n\n원문 (한국어):\n${text}`,
  support_escalation_template_ko: (text) =>
    `Build a Korean support escalation template for when a Tier-1 support agent needs to escalate to engineering / on-call. Use 합쇼체. 받는 엔지니어가 5분 안에 컨텍스트를 파악할 수 있게. Markdown sections: '**티켓 ID + 한 줄 요약**' (1줄 — '#NNNNN — [한 줄 영향]'), '**Severity 판정 + 이유**' (1줄 — 'Sev[X] — [근거 1줄]. 영향 N명 / 영향 받는 기능 / 매출 영향 있음 여부'), '**고객 컨텍스트**' (bullets — 고객사명 / 계약 등급 / 핵심 사용자 여부 / 이전 비슷한 케이스 있었나), '**증상 (사용자가 본 것)**' (1-2 단락 — 인용 포함, 사용자 단어 그대로), '**우리가 확인한 것**' (numbered — 우리 측에서 어떤 로그 / 메트릭 / 재현 시도를 어디서 했고 무엇을 봤는지 — 화면 캡처 / 로그 ID placeholder), '**우리 가설**' (1-2 bullets — 우리 추정 — 확신도 명시 '낮음 / 중간 / 높음'), '**임시 완화 가능?**' (1줄 — 사용자에게 안내할 수 있는 우회법 있나), '**부탁드리는 것**' (bullets — 어떤 영역 / 어떤 결정 / 응답 SLA — 'Sev1: 30분 / Sev2: 4시간 / Sev3: 다음 영업일'), '**연락처**' (1줄 — Slack DM + 폰).\n\n티켓 / 상황 컨텍스트:\n${text}`,
  team_offsite_agenda_2day_ko: (text) =>
    `Design a Korean 2-day team offsite agenda. Use 해요체. Day 1 = 발산 / 관계, Day 2 = 수렴 / 결정. Markdown structure per day: '### Day N — [Day theme]' followed by hourly timeline table ('시간 | 세션 | 형식 | 진행자 | 산출물'). 권장 Day 1: 9:00 도착 + coffee, 9:30 오프닝 + 안전감 만들기, 10:00 미션 / 비전 리캡 (CEO), 11:00 회사 컨텍스트 발산 — 시장 / 경쟁 / 고객, 12:30 점심 + 가벼운 페어링 액티비티, 14:00 팀 단위 발산 — '내가 자랑스러웠던 순간 / 막힌 순간' 공유, 15:30 break, 16:00 cross-team 인터뷰 — 다른 팀이 우리한테 듣고 싶은 것, 18:00 저녁 + 인포멀 액티비티. Day 2: 9:00 어제 핵심 패턴 압축 (퍼실), 10:30 break, 11:00 다음 분기 가장 큰 베팅 후보 발산 → 좁히기, 12:30 점심, 14:00 결정 / commit — 누가 / 무엇을 / 언제까지, 16:00 클로징 — 한 사람씩 약속 1줄 + 회고 한 단어, 17:00 마무리. 끝에 '**준비 가이드**' (3 bullets — 사전 설문 / 퍼실 외주 / 결정 capture 책임자) + '**예산 가이드**' (1줄).\n\n팀 / 분위기 / 이번 offsite 목표:\n${text}`,
  translate_ko_to_french: (text) =>
    `Translate the Korean text below into natural French. 프랑스어의 격식 시스템 (vous / tu), 성 (m/f), 시제 일치, 동사 활용을 정확히. 격식은 원문에 맞춤 (한국어 합쇼체 → 'vous' + 정중 / 해요체 → 'vous' / 반말 → 'tu'). 한국어 한자어는 프랑스어 자연스러운 표현으로 의역, 비즈니스 / 학술 표현은 프랑스 관습 존중. Reply with two sections: '**Traduction**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격식 / 시제 결정 1가지, 2) 의역한 한자어 1가지, 3) 프랑스어 관습 고려 1가지).\n\n원문 (한국어):\n${text}`,
  internal_changelog_dev_ko: (text) =>
    `Convert raw merge log / PR descriptions into a Korean internal dev changelog — for the engineering team's own reading, not customers. Use 해요체. Markdown sections: '**Week of YYYY-MM-DD**' (헤더), '**🚀 Shipped**' (bullets — 머지된 것, 각 '한 줄 명사형 [PR#N — @작성자]' 형식), '**🧪 Behind a flag**' (bullets — feature flag 뒤에 들어간 것), '**🔧 Infra / DX**' (bullets — 빌드 / CI / 개발 환경 변경), '**🐛 Fixed**' (bullets — 버그 수정 — Sev 표시), '**📚 Docs / Tests**' (bullets — 문서 / 테스트 추가), '**⚠️ Heads up**' (bullets — 다음 주 영향 있을 변경 — 마이그레이션 / deprecate 예정 / breaking change), '**🤝 Thanks**' (1줄 — 이번 주 도움 준 다른 팀 호명 — 가짜 이름 안 만듦, 입력에 없으면 생략), '**📊 숫자**' (1줄 — 머지 PR 수 / 코드 라인 변화 / 테스트 커버리지 변화 1줄).\n\nMerge 로그 / PR 메모:\n${text}`,
  translate_ko_to_italian: (text) =>
    `Translate the Korean text below into natural Italian (italiano). 이탈리아어의 격식 시스템 ('Lei' 정중 / 'tu' 친근), 성 (m/f), 동사 활용, 시제 일치를 정확히. 격식은 원문에 맞춤 (한국어 합쇼체 → 'Lei' + 정중 / 해요체 → 'Lei' / 반말 → 'tu'). 한국어 한자어 / 외래어는 이탈리아어 자연스러운 표현으로 의역, 비즈니스 표현은 이탈리아 관습 존중. Reply with two sections: '**Traduzione**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격식 / 시제 결정 1가지, 2) 의역한 한자어 1가지, 3) 이탈리아 문화 컨텍스트 고려 1가지).\n\n원문 (한국어):\n${text}`,
  linkedin_company_post_ko: (text) =>
    `Write a Korean LinkedIn company page post for the announcement / story below. Use 해요체. 회사 계정 톤 — 개인 thought-leader 톤과 다름, 좀 더 정돈되고 진중하게, 그러나 corporate 빈말 금지. Markdown structure: '**Hook (첫 2줄, 280자 이내)**' (1-2줄 — Linkedin 모바일 잘림 직전까지 임팩트 — 의외의 통계 / 강한 약속 / 사람 이야기 시작), '**본문**' (500-700자, 3-4 짧은 단락 — 회사 입장에서 무엇 / 왜 / 어떻게 / 누구를 위한지), '**숫자 또는 인용 1개**' (1줄 — '> "..." — 직원/고객 이름 + 직책'), '**Call-to-engagement**' (1줄 — 댓글 유도 작은 질문 — 너무 corporate한 'thoughts?' 금지, 구체적으로), '**해시태그**' (3-5개 — 너무 일반적 (#성공, #리더십) 피하기, 회사 도메인 + 캠페인 한 단어 위주). 끝에 '**미디어 권장**' (1줄 — 이미지 / 영상 / 캐러셀 중 어떤 형식이 좋을지 + 그 안에 보일 핵심).\n\n발표 / 회사 컨텍스트:\n${text}`,
  translate_ko_to_spanish: (text) =>
    `Translate the Korean text below into natural Spanish (español). 스페인어의 격식 시스템 ('usted' 정중 / 'tú' 친근), 성 / 수 일치, 동사 활용을 정확히. 라틴 아메리카 vs 스페인 스페인어의 어휘 차이는 입력 맥락에서 추론 — 기본은 표준 스페인어, 한국 비즈니스 문서면 라틴 아메리카 시장 의식한 표현 권장. 격식은 원문에 맞춤 (한국어 합쇼체 → 'usted' + 정중 / 해요체 → 'usted' 또는 'tú' / 반말 → 'tú'). Reply with two sections: '**Traducción**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격식 / 변종 (스페인 vs 라틴 아메리카) 결정 1가지, 2) 의역한 표현 1가지, 3) 동사 활용 결정 1가지).\n\n원문 (한국어):\n${text}`,
  translate_ko_to_japanese_business: (text) =>
    `Translate the Korean text below into formal Japanese business style (ビジネス日本語). 日本語 「です・ます」 정중체 + 「お〜」「ご〜」 접두사 적극, 「いただきます」「させていただきます」 같은 정중 표현. 결재 / 사외 메일 / 사외 발표용 적합한 격식. 한국식 직설 표현 → 日本式 婉曲 (예: '확인 부탁드립니다' → 'ご確認のほどよろしくお願いいたします'). 한국어 한자어는 일본 한자어 대응이 있으면 그대로, 다르면 의역. Reply with two sections: '**翻訳**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 婉曲 표현 의역 1가지, 2) 한자어 처리 1가지, 3) 일본 비즈니스 관습 고려 1가지 — お疲れ様 / 失礼します 같은 정형구 사용 결정).\n\n원문 (한국어):\n${text}`,
  product_naming_brainstorm_ko: (text) =>
    `Brainstorm 10 Korean product / feature name candidates for the concept below. Use 해요체 for notes. Format each as '### Variant N — [네이밍 각도]' followed by '**Name**' (1줄 — 4-12자), '**유래 (Etymology)**' (1줄 — 어디서 왔는지: 한자어 / 고유어 / 외래어 / 합성어), '**연상 / 톤**' (1줄 — 이 이름을 들었을 때 떠오르는 이미지 1줄), '**Pros**' (1줄), '**Cons**' (1줄). 각도 다양화: 한자어 (간결 / 격식) / 순한국어 (친근) / 영어 단어 (글로벌) / 합성어 (브랜드만의) / 의성어 / 의태어 / 신조어 / 동물 / 자연물 / 추상명사. 끝에 '**탑 픽 3개 + 이유 (이름 / 한 줄 이유)**' + '**상표 / 도메인 체크 추천**' (1줄 — KIPRIS / namecheap placeholder).\n\n제품 / 컨셉 컨텍스트:\n${text}`,
  translate_ko_to_portuguese: (text) =>
    `Translate the Korean text below into natural Portuguese (português). 포르투갈 vs 브라질 변종은 입력 맥락에서 추론, 기본은 브라질 포르투갈어 (글로벌 사용자 더 많음). 격식 시스템 ('senhor/a' 정중 / 'você' 일상 / 'tu' 일부 지역 친근), 성 / 수 일치, 동사 활용 정확히. 격식은 원문에 맞춤 (한국어 합쇼체 → 'senhor/a' + 정중 / 해요체 → 'você' / 반말 → 'você' 친근하게). Reply with two sections: '**Tradução**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 변종 (브라질 vs 포르투갈) 결정 1가지, 2) 의역한 표현 1가지, 3) 동사 시제 결정 1가지).\n\n원문 (한국어):\n${text}`,
  cross_team_async_update_ko: (text) =>
    `Draft a Korean cross-team async update post (Slack 또는 Notion 게시) — '내가 속한 팀이 다른 팀에게 보내는 정기 업데이트'. Use 해요체. 5분 안에 읽고 다음 액션 잡을 수 있게. Markdown sections: '**제목**' (1줄, 28자 이내 — '[보내는 팀] → [받는 팀] 이번 주 업데이트 — YYYY-MM-DD' 류), '**한 줄 핵심**' (1줄 — 받는 팀이 알아야 할 가장 중요한 1가지), '**우리 팀에서 진척된 것 (3 bullets)**' (각 1줄, 받는 팀이 신경 쓰는 영역 위주로 골라), '**받는 팀에 영향 있는 변경 (있으면)**' (bullets — '곧 X가 바뀝니다, 여러분 쪽 Y에 영향이 있을 수 있어요' + 시점), '**받는 팀에 부탁 (있으면)**' (numbered — 구체적 — 누가 / 무엇을 / 언제까지), '**다음 업데이트 시점**' (1줄 — 'YYYY-MM-DD 다음 업데이트 보내드릴게요'), '**질문 채널**' (1줄 — Slack 채널 + 답변 SLA).\n\n이번 주 우리 팀 진척 / 받는 팀 컨텍스트:\n${text}`,
  customer_health_score_definition_ko: (text) =>
    `Define a Korean Customer Health Score from the customer-success signals below. Use 해요체. Markdown sections: '**Score 정의 (1줄)**' (1줄 — 0-100점 / 빨강-노랑-초록 등 어떤 척도), '**Score 공식**' (1단락 — 어떤 신호들을 어떤 가중치로 합하는지, 가능하면 수식 1줄), '**신호별 정의 (테이블)**' (컬럼: '신호 | 측정 방법 | 가중치 | 데이터 출처'. 신호 예: Product usage frequency, depth of feature use, support ticket volume, NPS, CSM-relationship strength, contract value trend), '**Score → 액션 매핑**' (테이블 — 'Score 구간 | 색 라벨 | 권장 액션 | 책임자'), '**False positive / False negative 사례**' (2 bullets — score가 거짓 신호 줄 수 있는 케이스 + 우리가 어떻게 보정), '**모니터링 / 리뷰 cadence**' (1줄 — 누가 / 얼마 만에 score 정의 자체를 재검토), '**시작 사용 가이드 (3 bullets)**' — 1) 처음 N개월은 score 자체를 만든다고 생각, 2) 액션을 너무 자동화하지 말기, 3) score는 도구일 뿐 사람 판단을 대체하지 않음.\n\n고객 / 신호 컨텍스트:\n${text}`,
  translate_ko_to_polish: (text) =>
    `Translate the Korean text below into natural Polish (polski). 폴란드어의 격 7개 (mianownik / dopełniacz / celownik / biernik / narzędnik / miejscownik / wołacz), 성, 동사상 (dokonany / niedokonany), 수 일치를 정확히. 격식은 원문에 맞춤 ('Pan / Pani' 격식 → 한국어 합쇼체 / 'ty' 친근 → 반말). 한국어 한자어 → 폴란드어 자연스러운 명사로 의역. Reply with two sections: '**Tłumaczenie**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격 결정 1가지, 2) 동사상 결정 1가지, 3) 의역한 표현 1가지).\n\n원문 (한국어):\n${text}`,
  marketing_email_ab_subject_5_ko: (text) =>
    `Generate 5 Korean marketing email subject line variants for A/B testing the campaign below. Use 해요체. 각 subject 24자 이내, 이모지 1개 이내 (대부분 0). Format: '### N — [각도]' followed by '**Subject**' (1줄), '**Preheader**' (1줄, 80자 이내), '**가설**' (1줄 — 이 subject가 이기면 무엇을 의미하는지). 각도 다양화: 1) **직설형** — 베네핏 명사형, 2) **호기심형** — 질문 또는 의외, 3) **개인화** — 이름 / 행동 reference (\`{first_name}\`), 4) **긴급형** — 시간 / 한정성, 5) **소셜 프루프형** — 'X 사람이 이미...'. 끝에 '**테스트 권고**' (3 bullets — 1) 메인 메트릭 (open rate가 1차, 이지만 click도 같이 봐야 함), 2) 모수 권장, 3) 결과 보기 전에 본인 가설 1줄 미리 적기).\n\n캠페인 / 청중 컨텍스트:\n${text}`,
  translate_ko_to_dutch: (text) =>
    `Translate the Korean text below into natural Dutch (Nederlands). 네덜란드어의 격식 시스템 ('u' 정중 / 'jij/je' 일상), 성 (de/het 단어), 어순 (verb-second 규칙), 분리동사 (scheidbare werkwoorden)를 정확히. 격식은 원문에 맞춤 (한국어 합쇼체 → 'u' / 해요체 → 'u' 또는 'je' / 반말 → 'jij'). 한국어 한자어 → 네덜란드어 자연스러운 명사로 의역. Reply with two sections: '**Vertaling**' (the translated text, paragraph breaks preserved) and '**번역 노트**' (3 bullets in Korean — 1) 격식 결정 1가지, 2) 어순 / 분리동사 처리 1가지, 3) 의역한 표현 1가지).\n\n원문 (한국어):\n${text}`,
  pre_launch_checklist_ko: (text) =>
    `Build a Korean pre-launch checklist for the product / feature release below. Use 해요체. 출시 D-7부터 D-day까지 단계별 체크박스. Markdown structure per day: '### D-7 (1주 전)' followed by '- [ ] 항목 — 담당자 — 1줄 메모'. 권장 단계: **D-7**: 모든 코드 머지 / 카피 최종 / 디자인 자산 확정 / 베타 사용자 사전 안내, **D-3**: 마케팅 자산 게시 일정 / 고객 응대팀 사전 브리핑 / 가격 / 결제 / 분석 트래킹 검증, **D-1**: 도메인 / DNS / SSL / 캐싱 검증 / status page 준비 / 마지막 dry-run / 롤백 plan 확인, **D-day morning**: 출시 토글 / smoke test / 첫 30분 모니터링 + 핵심 KPI 대시보드 / 외부 채널 게시 순서 (블로그 → 메일 → 소셜 → 커뮤니티), **D-day afternoon**: 활성 모니터링 + 사용자 첫 피드백 수집 / 응대 팀에 자주 묻는 질문 실시간 공유, **D+1**: 24시간 데이터 리뷰 + 빠른 버그 fix triage. 마지막 '**롤백 트리거**' (3 bullets — 어떤 신호가 보이면 출시를 되돌릴지) + '**출시 후 30일 회고 일정**' (1줄).\n\n출시 컨텍스트:\n${text}`,
  founder_well_being_check_ko: (text) =>
    `Build a Korean founder well-being self-check from the founder's recent state notes below. Use 해요체. 진단이 아니라 자기인식 도구 — 단정 금지, 패턴을 보여주기. Markdown sections: '**한 줄 분위기 (1줄)**' (1줄 — 1-10 자가 평가 + 한 단어 형용사), '**6 영역 점검 (테이블)**' (컬럼: '영역 | 최근 1주 1-5 점수 | 한 줄 신호 | 변화 방향'. 영역: 1) 수면 (시간 + 질), 2) 신체 (운동 / 식사 / 통증), 3) 관계 (배우자 / 가족 / 친구 만남 빈도), 4) 일 (에너지 / 막힘 / 의사결정 피로), 5) 재정 (개인 / 회사 분리 / 6개월 buffer), 6) 즐거움 (취미 / 일과 무관한 활동)), '**Red flags (지금 신경 써야 할 신호 3 bullets)**' (점수 낮은 영역 / 트렌드가 빠르게 나빠지는 영역 / 본인이 부정하는 패턴), '**작은 실험 3가지**' (이번 주에 시도할 작은 변화 — '잠 30분 더', '평일 1번 점심 산책', '주말 1번 폰 끄기' 류 — 거창하지 않게), '**지원 시스템 점검 (1줄씩)**' (3 bullets — 1) 코치 / 멘토 마지막 만남 언제, 2) 동기 창업자 / 동료 창업자 솔직한 대화 마지막 언제, 3) 신뢰하는 사람한테 도움 요청 가능한가), '**한 가지 약속**' (1줄 — 다음 1주 동안 자기 자신과 지킬 1가지). 진단 / 의학적 조언 금지, 전문가 상담 필요한 신호 보이면 1줄로 권유.\n\n최근 1-2주 상태 메모:\n${text}`,
  translate_ko_to_swedish: (text) =>
    `Translate the Korean text below into natural Swedish. 격식은 원문 톤에 맞춤 (한국어 합쇼체 → 정중 'ni' 또는 표준 'du' / 해요체 → 'du' / 반말 → 'du' 친근). 스웨덴어는 'du-reformen' 이후 대부분 'du' 사용. Reply with two sections: '**Översättning**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  all_hands_qna_doc_ko: (text) =>
    `Build a Korean Q&A doc to publish after an all-hands. Use 해요체. Markdown sections: '**한 줄 컨텍스트**' (1줄 — 어떤 미팅 / 언제), '**답변된 질문**' (각 '### Q. [질문]' + '**A.** [답 1-2단락]' + '담당: @이름'), '**답변 못 한 질문 (followup 필요)**' (bullets — 질문 + 담당자 + 답변 약속 시점), '**자주 묻는 후속 질문**' (3 bullets — 아직 안 나왔지만 곧 나올 만한 질문 + 짧은 답), '**미팅 자료 / 슬라이드**' (1줄 — 링크 placeholder).\n\nQ&A 원본:\n${text}`,
  ux_writing_button_5_ko: (text) =>
    `Write 5 Korean button label variants for the action described below. Use 해요체 or 명사형. 각 8자 이내, 동사형 권장. Format: 'N. [라벨] — 톤 1줄'. 톤 다양화: 1) 직설 명령 ('지금 시작'), 2) 베네핏 ('5분에 끝내기'), 3) 친근 ('가볍게 살펴보기'), 4) 안전 ('카드 없이 시작'), 5) FOMO ('한정 액세스'). 끝에 '**Top pick + 이유**' 1줄.\n\n액션 / 페이지:\n${text}`,
  partner_intro_call_followup_ko: (text) =>
    `Draft a Korean follow-up email after a first partnership call. Use 해요체. Markdown: '**제목**' (1줄, 24자 이내), '**본문**' (4 단락: 1) 시간 감사 + 미팅에서 가장 기억 남은 1줄 reference, 2) 우리가 약속한 자료 / 답변 — 1주일 안에 보낼 것, 3) 다음 단계 제안 — 'X 결정 후 우리 쪽 PM 한 분 더 모셔 30분 더 깊은 대화 어떠세요', 4) 그쪽 결정을 위한 도움 — 우리한테 더 필요한 자료가 있으면 부탁), '**첨부 / 링크**' (bullets).\n\n미팅 컨텍스트:\n${text}`,
  translate_ko_to_turkish: (text) =>
    `Translate the Korean text below into natural Turkish (Türkçe). 격식은 원문에 맞춤 (합쇼체 → 'siz' + 정중 / 해요체 → 'siz' / 반말 → 'sen'). 터키어의 풍부한 접미사 시스템 (-ler, -dir, -mek 등)을 자연스럽게. Reply with two sections: '**Çeviri**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  security_advisory_user_ko: (text) =>
    `Write a Korean user-facing security advisory for the vulnerability / issue described below. Use 합쇼체. 솔직 + 명확 — 무엇이 / 누구에게 영향 / 무엇을 해야 하나 / 우리가 무엇을 했나. Markdown sections: '**한 줄 요약**' (1줄 — 'YYYY-MM-DD에 발견된 X 취약점 안내'), '**영향**' (1-2줄 — 어떤 데이터 / 누가 / 기간), '**우리가 즉시 한 것**' (bullets), '**사용자가 해야 할 것**' (numbered — 비밀번호 변경 / 세션 로그아웃 / 패치 적용 등), '**우리가 다음에 할 것**' (bullets — 사후 보고서 일정 / 추가 조사), '**문의처**' (1줄).\n\n취약점 컨텍스트:\n${text}`,
  translate_ko_to_hebrew: (text) =>
    `Translate the Korean text below into natural Hebrew (עברית). RTL 흐름, 성별 (m/f) 활용, 격식 시스템 ('אתה/את' vs 'הם') 정확히. 격식은 원문에 맞춤. Reply with two sections: '**תרגום**' and '**번역 노트**' (3 bullets in Korean — 1) 성별 결정 1가지, 2) 의역 1가지, 3) RTL 흐름 고려 1가지).\n\n원문:\n${text}`,
  retention_cohort_writeup_ko: (text) =>
    `Write a Korean cohort retention analysis writeup. Use 해요체. Markdown: '**한 줄 결론**' (1줄 — 'D7 / D30 / D90 retention이 X% / Y% / Z%, 업계 벤치마크 대비 어떠한지'), '**코호트 정의**' (1줄 — 어떤 사용자 / 어떤 시점 기준), '**retention 곡선 묘사**' (1단락 — 어디서 가파르게 떨어지고 어디서 평평해지는지), '**세그먼트별 차이**' (bullets — 채널 / 페르소나 / 첫 행동별 차이 + 유의미한 격차), '**가설**' (2 bullets — 곡선 모양을 설명할 만한 메커니즘), '**다음 실험 후보**' (3 bullets — retention 개선 후보).\n\n데이터:\n${text}`,
  talent_offer_letter_ko: (text) =>
    `Draft a Korean job offer letter (formal section + warm cover). Use 합쇼체 for formal, 해요체 for cover. Markdown: '**Cover note (1단락)**' (3-4줄 — 따뜻한 어조, 왜 이 사람이 우리에게 중요한지 1줄), '**제안 조건 (테이블)**' ('항목 | 내용'. 직책 / 시작일 / 연봉 / 사이닝 보너스 / 옵션 / 휴가 / 근무 형태), '**기간 / 응답 시점**' (1줄 — '본 제안은 YYYY-MM-DD까지 유효합니다'), '**다음 단계**' (bullets — 수락 시 절차 / 질문 가능한 사람 / 첫 주 안내), '**서명**' (직책 + 이름 + 회사).\n\n포지션 / 조건:\n${text}`,
  translate_ko_to_norwegian: (text) =>
    `Translate the Korean text below into natural Norwegian (Bokmål default). 격식은 원문 톤에 맞춤. 노르웨이어는 대부분 'du' 사용. Reply with two sections: '**Oversettelse**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  investor_followup_silence_ko: (text) =>
    `Draft a Korean follow-up email to an investor who's been silent 2-3 weeks. Use 합쇼체. 짧고 가볍게, 압박 톤 금지. Markdown: '**제목**' (1줄, 22자 이내, '간단한 업데이트 + 한 줄 질문' 류), '**본문**' (3 단락: 1) 짧은 안부 + 'X 주 전 대화 이후 한 줄 진척', 2) 그쪽 결정에 영향 줄 만한 새 정보 1가지 — 메트릭 / 고객 / 인사 등, 3) 'pass 결정이면 1줄로 알려주셔도 OK입니다' 1줄), '**P.S.**' (1줄).\n\n맥락:\n${text}`,
  translate_ko_to_finnish: (text) =>
    `Translate the Korean text below into natural Finnish (suomi). 핀란드어의 15가지 격, 동사 활용, 모음조화를 정확히. 격식은 원문 톤에 맞춤 (대부분 'sinä' 단수 / 'te' 정중 또는 복수). Reply with two sections: '**Käännös**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  brand_color_palette_ko: (text) =>
    `Generate a Korean brand color palette spec for the brand described below. Use 해요체. Markdown sections: '**브랜드 한 줄 (1줄)**' (1줄 — 톤 형용사 3개), '**Primary (1개)**' (HEX + 이름 + 사용처 1줄), '**Secondary (2개)**' (각 HEX + 이름 + 사용처), '**Neutrals (5단계)**' (테이블 — '이름 | HEX | 사용처'), '**Accent / Status (5개)**' (success / warning / danger / info / muted — 각 HEX + 사용처), '**다크모드 매핑**' (테이블 — 라이트 → 다크 변환표), '**접근성 노트**' (3 bullets — primary on white / on dark 대비비 + WCAG AA 통과 여부), '**금기 (Don'ts)**' (2 bullets — 절대 같이 안 쓸 조합).\n\n브랜드:\n${text}`,
  customer_pain_interview_qs_ko: (text) =>
    `Generate 8 Korean customer pain interview questions for the persona / domain below. Use 해요체. 열린 질문 위주, 행동을 묻기, 'why' 보다 'how / when / tell me about a time'. Format: numbered list. 끝에 '**진행 가이드 (3 bullets)**' — 1) 침묵 견디기, 2) follow-up 질문 'tell me more about that', 3) 해결책 미리 묻지 않기.\n\n페르소나 / 도메인:\n${text}`,
  translate_ko_to_danish: (text) =>
    `Translate the Korean text below into natural Danish (dansk). 격식은 원문에 맞춤 (대부분 'du'). Reply with two sections: '**Oversættelse**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  sales_email_winback_d60_ko: (text) =>
    `Draft a Korean D+60 winback sales email — 60일 동안 응답 없는 lead에게. Use 해요체. 마지막 시도 톤 — 짧고 honest. Markdown: '**제목**' (1줄, 20자 이내), '**본문**' (3 단락: 1) 'X 달 전 대화 이후 한 줄 안부', 2) 그동안 우리가 변한 것 1줄 + 그쪽 회사 / 산업에서 우리가 본 1가지 reference, 3) 정확한 질문 — '지금 이게 우선순위 아니면 1줄 답장 부탁드려요. 그러면 더 이상 연락 드리지 않을게요'), '**P.S.**' (1줄).\n\nLead 컨텍스트:\n${text}`,
  sprint_review_demo_outline_ko: (text) =>
    `Build a Korean sprint review demo outline (45분 분량). Use 해요체. Markdown: '**스프린트 한 줄**' (1줄), '**Agenda (테이블)**' ('시간 | 항목 | 시연자'. 0-5분 인트로 + 스프린트 목표 리캡, 5-25분 데모 (기능 3-4개), 25-35분 메트릭 + 학습, 35-42분 다음 스프린트 미리보기, 42-45분 Q&A), '**각 데모 항목**' (시연 단계 + 멘트 1줄 + 예상 질문 1개), '**준비물**' (bullets — 데모 환경 / 백업 시나리오 / 화면 공유 누가).\n\n스프린트 결과:\n${text}`,
  translate_ko_to_czech: (text) =>
    `Translate the Korean text below into natural Czech (čeština). 격, 성, 동사상 정확히. 격식 ('vy' 정중 / 'ty' 친근) 원문에 맞춤. Reply with two sections: '**Překlad**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  ad_copy_3_variations_ko: (text) =>
    `Write 3 Korean ad copy variations for the same offer below. Use 해요체. Format: '### V1 — 베네핏형', '### V2 — 페인형', '### V3 — 호기심형'. 각각 'Headline:' (1줄, 14자 이내), 'Body:' (1줄, 40자 이내), 'CTA:' (1줄, 6자 이내). 끝에 '**테스트 가이드**' (2 bullets — 메인 메트릭 + 모수 권장).\n\n오퍼:\n${text}`,
  ai_eval_rubric_ko: (text) =>
    `Build a Korean evaluation rubric for an AI feature / agent. Use 합쇼체. Markdown: '**평가 목표 (1줄)**', '**Rubric 차원 (테이블)**' (컬럼: '차원 | 정의 | 1점 | 3점 | 5점 | 가중치'. 차원: 정확성 / 도움 정도 / 안전성 / 톤 / 형식 일관성 / 환각 정도), '**Eval set 구성**' (bullets — N개 케이스 / 카테고리 분포 / 어려운 케이스 비중), '**평가 방법**' (1줄 — 자동 LLM-judge vs 사람 vs 혼합), '**합격 기준**' (1줄 — 전체 평균 X점 / 모든 차원 Y점 이상 등).\n\nAI 기능 컨텍스트:\n${text}`,
  translate_ko_to_greek: (text) =>
    `Translate the Korean text below into natural Greek (ελληνικά). 격, 성, 동사 활용 정확히. 격식 ('εσείς' 정중 / 'εσύ' 친근) 원문에 맞춤. Reply with two sections: '**Μετάφραση**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  contract_negotiation_email_ko: (text) =>
    `Draft a Korean contract redline email — sent when sending back marked-up contract. Use 합쇼체. Markdown: '**제목**' (1줄, 27자 이내 — '[계약 종류] 검토 의견 전달 — YYYY-MM-DD'), '**본문**' (4 단락: 1) 검토 시간 감사 + 첨부 안내, 2) 핵심 변경 3가지 — '조항 N: ... 수정 — 이유 1줄', 3) 우리 입장 — 양보 가능 vs 깨질 수 없는 것 명확히, 4) 다음 단계 — '내부 변호사 검토 후 X일 안에 회신'), '**첨부**' (1줄).\n\n계약 / 변경 요구:\n${text}`,
  podcast_pitch_to_show_ko: (text) =>
    `Draft a Korean cold pitch email to a podcast host to be a guest. Use 해요체. Markdown: '**제목**' (1줄, 24자 이내 — '[팟캐스트명] 게스트 제안: [주제 한 줄]'), '**본문**' (4 단락: 1) 어떤 에피소드를 들었는지 + 구체적 통찰 1줄, 2) 본인 + 회사 한 줄 + 이 팟캐스트 청취자가 왜 흥미로워할지, 3) 제안하는 에피소드 주제 1개 + 3-5 talking points, 4) 'NO도 정말 괜찮습니다' 1줄), '**자료**' (bullets — 본인 사진 / 회사 1페이저 / 이전 출연 영상 등 placeholder).\n\n호스트 / 본인:\n${text}`,
  translate_ko_to_hungarian: (text) =>
    `Translate the Korean text below into natural Hungarian (magyar). 헝가리어의 접미사 시스템, 모음조화, 격 정확히. 격식 ('Ön' 정중 / 'te' 친근) 원문에 맞춤. Reply with two sections: '**Fordítás**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_referral_request_ko: (text) =>
    `Draft a Korean email asking an existing customer for a referral. Use 해요체. 짧고 진심으로. Markdown: '**제목**' (1줄, 22자 이내 — '비슷한 분 한 분 추천 부탁드려요' 류), '**본문**' (3 단락: 1) 한 줄 감사 + 그쪽이 우리한테 한 구체적 1가지 reference, 2) 우리가 찾는 분 정확히 — '비슷한 산업 / 비슷한 페인 가진 분 1-2명', 3) 부탁 — '소개 메일 한 줄 써주시면 정말 큰 도움이에요. 못 해도 OK 톤'), '**리워드 (선택)**' (1줄 — 입력에 있으면).\n\n고객 컨텍스트:\n${text}`,
  translate_ko_to_romanian: (text) =>
    `Translate the Korean text below into natural Romanian (română). 격, 성, 동사 활용 정확히. 격식 ('dumneavoastră' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Traducere**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  weekly_ic_writeup_ko: (text) =>
    `Convert an IC (Individual Contributor) engineer's weekly notes into a clean Korean writeup. Use 해요체. Markdown: '**한 줄 요약**' (1줄 — 이번 주 본인 가장 큰 기여), '**Shipped**' (bullets — 머지된 PR 1줄씩), '**진행 중**' (bullets — 다음 주 끝낼 것 + 현재 % + 막힘 여부), '**막힌 것 / 도움 필요**' (bullets — 정확히 누구의 무엇 필요), '**배운 것**' (1-2 bullets — 기술적 / 협업 학습), '**다음 주 베팅**' (2 bullets).\n\nIC 노트:\n${text}`,
  faq_from_support_tickets_ko: (text) =>
    `Generate a Korean FAQ from recurring support ticket themes below. Use 해요체. Format: '### Q. [질문]' + '**A.** [답 2-3줄 — 친근하고 단계적으로]' + '**관련 도움말 / 액션**' (1줄 placeholder). 자주 묻는 5-8개를 추출, 유사 질문은 1개로 통합. 끝에 '**Internal 노트**' (2 bullets — 1) 어떤 질문이 가장 자주 오는지 1줄, 2) 제품 / UI에서 고치면 이 FAQ 자체가 줄어들 만한 것).\n\n티켓 모음:\n${text}`,
  translate_ko_to_swahili: (text) =>
    `Translate the Korean text below into natural Swahili (Kiswahili). 격식 ('mwalimu' 호칭 / 'wewe' 친근) 원문에 맞춤. 스와힐리어 명사 클래스 정확히. Reply with two sections: '**Tafsiri**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  growth_loop_design_ko: (text) =>
    `Design a Korean growth loop for the product described below. Use 해요체. Markdown: '**Loop 한 줄**' (1줄 — '[trigger] → [action] → [output] → [trigger]' 형식), '**단계별 정의 (테이블)**' ('단계 | 트리거 | 행동 | 결과 | 다음 트리거로 어떻게 이어지나'), '**핵심 메트릭 (각 단계마다)**' (bullets — 각 단계 통과율 측정 가능한 1개씩), '**Loop이 무너지는 지점 (3가지)**' (numbered — 각 어떤 신호로 알 수 있나), '**가속 레버 (3가지)**' (bullets — 어떤 변화가 loop 속도를 높일 수 있나), '**유사 / 다른 회사 사례**' (1줄).\n\n제품 / 페르소나:\n${text}`,
  translate_ko_to_ukrainian: (text) =>
    `Translate the Korean text below into natural Ukrainian (українська). 격, 성, 동사상 정확히. 격식 ('Ви' 정중 / 'ти' 친근) 원문에 맞춤. Reply with two sections: '**Переклад**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  decision_log_entry_ko: (text) =>
    `Write a Korean decision log entry for the decision below. Use 합쇼체. Markdown: '**Decision ID + 제목**' (1줄 — 'DEC-NNN — [짧은 제목]'), '**Date / Decider**' (1줄), '**Context (3-4줄)**' (배경 — 왜 결정이 필요했는지), '**Options considered**' (bullets — 옵션 + 장단점 1줄씩), '**Decision (한 줄 굵게)**' (1줄), '**Why**' (2-3줄 — 결정 근거), '**Risks**' (2 bullets — 이 결정이 깨질 만한 조건), '**Review trigger**' (1줄 — 언제 재평가).\n\n결정 컨텍스트:\n${text}`,
  customer_video_testimonial_brief_ko: (text) =>
    `Build a Korean brief for filming a customer video testimonial. Use 해요체. Markdown: '**Subject 한 줄**' (1줄 — 누구 + 어떤 페인이 풀렸는지), '**준비물**' (bullets — 카메라 / 마이크 / 조명 / 장소), '**인터뷰 질문 5-7개**' (numbered — '이 도구 쓰기 전엔 어떻게 하셨어요?' 류 열린 질문 위주), '**핵심 쇼트 (B-roll 후보)**' (bullets — 5-6개 — 사용자의 작업 환경 / 화면 클로즈업 등), '**촬영 후 편집 노트**' (3 bullets — 길이 60-90초 / 자막 필수 / 끝에 사용자 사진 + 회사 로고).\n\n고객 / 스토리:\n${text}`,
  translate_ko_to_bulgarian: (text) =>
    `Translate the Korean text below into natural Bulgarian (български). 격, 성, 정관사 활용 정확히. 격식 ('Вие' 정중 / 'ти' 친근) 원문에 맞춤. Reply with two sections: '**Превод**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  recruiter_inmail_ko: (text) =>
    `Draft a Korean LinkedIn InMail from a recruiter to a passive candidate. Use 해요체, 짧고 personalized. Markdown: '**제목**' (1줄, 24자 이내), '**본문 (4 단락, 전체 500자 이내)**' (1) 어떻게 알게 됐나 + 그분이 한 일 구체적 1가지, 2) 우리 회사 / 포지션 1줄 + 그분이 흥미로워할 1가지, 3) 부담 없는 다음 단계 — '15분 짧은 통화 가능하실까요', 4) 'NO도 진심으로 OK' 1줄), '**P.S.**' (1줄 — 채용 안 가도 도움 될 자료 1개 placeholder).\n\n후보자 / 포지션:\n${text}`,
  translate_ko_to_serbian: (text) =>
    `Translate the Korean text below into natural Serbian (српски). Cyrillic 또는 Latin script — 입력 맥락에서 추론, 둘 다 가능하면 Latin 기본. 격, 성, 동사 활용 정확히. 격식 ('Vi' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Prevod**' and '**번역 노트**' (3 bullets in Korean — script 선택 1가지 포함).\n\n원문:\n${text}`,
  npm_package_readme_ko: (text) =>
    `Generate a Korean npm package README from the package info below. Output ready-to-paste markdown. Sections: '# 패키지 이름' + 1줄 tagline, badges 3개 placeholder (npm / build / license), '## 설치', code block ('npm install ...'), '## 사용 예', code block (가장 짧은 use case), '## API', 핵심 함수 / 옵션 2-4개 — 각 '### fnName(args)' + 1줄 설명 + 예제 코드, '## 옵션', bullet 또는 테이블, '## 기여 / 이슈', 1줄 + 링크 placeholder, '## 라이선스' (1줄). 한국어 자연스럽게.\n\n패키지 정보:\n${text}`,
  translate_ko_to_filipino: (text) =>
    `Translate the Korean text below into natural Filipino (Tagalog). 격식 ('po / ho' 정중 어말 / 없으면 친근) 원문에 맞춤. 한국어 한자어는 필리핀에서 통용되는 표현 또는 영어 외래어로. Reply with two sections: '**Pagsasalin**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  sales_qbr_internal_ko: (text) =>
    `Write a Korean internal sales QBR (Quarterly Business Review) doc — for the sales team's own review, not customer-facing. Use 합쇼체. Markdown: '**분기 한 줄**' (1줄 — 'Q[X] 목표 X달성 / Y미달성'), '**숫자 (테이블)**' ('지표 | 목표 | 실적 | 달성률 | 전분기 대비'. ARR / 신규 계약 / 평균 deal 크기 / sales cycle 길이 / win rate / pipeline coverage), '**잘 된 것**' (3 bullets — 큰 win / 새 채널 / 효과 본 활동), '**안 된 것**' (3 bullets — lost deal 패턴 / 막힌 단계), '**다음 분기 베팅**' (3 bullets — 산업 / 페르소나 / 메시지 변경), '**필요한 지원**' (bullets — 마케팅 / 제품 / CS에 부탁할 것).\n\n분기 데이터:\n${text}`,
  dei_statement_ko: (text) =>
    `Draft a Korean DEI (Diversity, Equity, Inclusion) statement for a company at the stage described below. Use 해요체. 솔직한 톤 — 빈말 / 과장 금지, 우리가 실제로 한 것 / 안 한 것 / 할 것을 명확히. Markdown: '**우리의 신념 (1단락)**' (3-4줄), '**지금 우리가 한 것**' (3 bullets — 데이터 또는 구체적 행동), '**지금 우리가 부족한 것**' (2 bullets — 솔직히), '**올해 commit**' (3 bullets — 측정 가능한 약속 + 시점), '**누가 책임지나**' (1줄 — 이름 / 역할).\n\n회사 / 현재 상태:\n${text}`,
  translate_ko_to_malay: (text) =>
    `Translate the Korean text below into natural Malay (Bahasa Melayu). 격식 ('anda' 정중 / 'kamu' 친근) 원문에 맞춤. Reply with two sections: '**Terjemahan**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_call_prep_qbr_ko: (text) =>
    `Build a Korean prep doc for a customer QBR call. Use 해요체. Markdown: '**고객 1줄**' (회사 / 산업 / 우리와의 관계 기간), '**지난 분기 우리가 한 것**' (bullets — 출시 / 지원 / 신규 도입 기능), '**고객 사용 패턴**' (3 bullets — 어떤 기능을 / 얼마나 / 누가), '**잘 된 것 (인용 가능하면)**' (1-2 bullets), '**막힌 것 / 우리가 들어줘야 할 것**' (bullets — 티켓 / 피드백 from CSM), '**다음 분기 같이 할 3가지**' (numbered — 구체적 action), '**갱신 / 확장 신호**' (1줄 — 갱신 의향 / 추가 모듈 / 좌석 확장), '**미팅 진행 가이드**' (3 bullets — 누가 진행 / 시간 분배 / 결정 1개 commit).\n\n고객 / 계약:\n${text}`,
  translate_ko_to_hindi: (text) =>
    `Translate the Korean text below into natural Hindi (हिन्दी). 격식 ('आप' 정중 / 'तुम' 친근 / 'तू' 더 친근) 원문에 맞춤. Devanagari script 정확히. Reply with two sections: '**अनुवाद**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  slack_channel_charter_ko: (text) =>
    `Draft a Korean Slack channel charter pinned message for the channel described below. Use 해요체. Markdown: '**한 줄 목적**' (1줄 — '이 채널은 ...를 위한 채널입니다'), '**누가 참여하나요**' (1줄), '**여기서 다루는 것**' (bullets), '**여기서 다루지 않는 것 (다른 채널 안내)**' (bullets — '~ 질문은 #other-channel로'), '**채널 룰 (3-5개)**' (numbered — 응답 SLA / 스레드 사용 / @here 자제 등), '**관리자 / 담당자**' (1줄 — 이름).\n\n채널 컨텍스트:\n${text}`,
  translate_ko_to_bengali: (text) =>
    `Translate the Korean text below into natural Bengali (বাংলা). 격식 ('আপনি' 정중 / 'তুমি' 친근 / 'তুই' 더 친근) 원문에 맞춤. Reply with two sections: '**অনুবাদ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  perf_calibration_doc_ko: (text) =>
    `Build a Korean performance calibration doc for the engineer / employee described below. Use 합쇼체. Markdown: '**평가 기간**' (1줄), '**평가 대상**' (1줄 — 직책 / 레벨), '**기간 임팩트 요약 (3-5 bullets)**' (결과 + 데이터), '**Strength (3 bullets)**' (구체적 행동 + 영향), '**Growth area (2 bullets)**' (구체적 + 다음 분기 개선 방향), '**제안 평가 (Rating)**' (1줄 — 'Exceeds / Meets / Below + 1줄 근거'), '**Calibration 노트**' (2 bullets — 매니저가 다른 calibrator에게 설명해야 할 미묘한 컨텍스트), '**제안 발전 액션**' (2 bullets — 다음 사이클까지 구체적 액션).\n\n임팩트 / 피드백 노트:\n${text}`,
  translate_ko_to_tamil: (text) =>
    `Translate the Korean text below into natural Tamil (தமிழ்). 격식 ('நீங்கள்' 정중 / 'நீ' 친근) 원문에 맞춤. Tamil script 정확히. Reply with two sections: '**மொழிபெயர்ப்பு**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  employer_brand_post_ko: (text) =>
    `Write a Korean employer brand post for LinkedIn / careers page. Use 해요체. 'we are hiring' 영업 톤 금지 — 우리 회사가 어떤 곳인지 보여주는 톤. Markdown: '**Hook (1-2줄)**' (의외의 사실 또는 사람 이야기로 시작), '**우리가 누구인가요 (1단락)**' (3-4줄 — 회사 / 미션 / 사람), '**여기서 일하면 어떤 것 (3 bullets)**' (구체적 — 'X 결정에 참여' / 'Y 도구 사용' / 'Z 학습' — 빈말 금지), '**우리에게 안 맞을 수도 있는 사람 (1-2 bullets)**' (솔직히 — 차별이 아니라 fit), '**열린 포지션 + CTA**' (1줄 — 채용 페이지 placeholder).\n\n회사 / 채용 컨텍스트:\n${text}`,
  translate_ko_to_urdu: (text) =>
    `Translate the Korean text below into natural Urdu (اردو). RTL 흐름, 격식 ('آپ' 정중 / 'تم' 친근 / 'تو' 더 친근) 원문에 맞춤. Reply with two sections: '**ترجمہ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  ux_research_recruitment_screener_ko: (text) =>
    `Build a Korean UX research participant recruitment screener for the target persona below. Use 해요체. Markdown: '**리서치 한 줄**' (1줄 — 무엇을 위한 리서치, 모수 N명), '**참여 조건 (Inclusion)**' (bullets — 구체적 — 직업 / 도구 사용 / 빈도 등), '**제외 조건 (Exclusion)**' (bullets — 우리 / 경쟁사 직원 / 이전 리서치 참가자 등), '**스크리너 질문 (객관식 5-7개)**' (각 질문 + 통과 / 탈락 답변 명시), '**보상**' (1줄 — '기프티콘 X만원 / 1개월 무료 / 사례비 Y만원'), '**참여 안내**' (1단락 — Zoom / 시간 / 녹화 동의 / 익명화).\n\n리서치 / 페르소나:\n${text}`,
  translate_ko_to_persian: (text) =>
    `Translate the Korean text below into natural Persian / Farsi (فارسی). RTL 흐름, 격식 ('شما' 정중 / 'تو' 친근) 원문에 맞춤. Reply with two sections: '**ترجمه**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_tools_doc_ko: (text) =>
    `Write Korean documentation for an internal tool described below. Use 해요체. Markdown: '**Tool 한 줄**' (이름 + 무엇을 위한 도구), '**누가 / 언제 쓰나요**' (1줄), '**접근 방법**' (bullets — URL / SSO / 권한 신청), '**기본 사용 흐름**' (numbered, 각 단계 1줄 + 스크린샷 placeholder), '**자주 쓰는 기능 3-5개**' (각 'h3 + 설명 + 예시'), '**조심할 것**' (2-3 bullets — 데이터 손실 위험 / 다른 팀 영향 / 권한 limit), '**문제 생기면**' (1줄 — Slack 채널 + 책임자).\n\n도구 컨텍스트:\n${text}`,
  translate_ko_to_burmese: (text) =>
    `Translate the Korean text below into natural Burmese (မြန်မာ). 격식 ('ခင်ဗျား / ရှင်' 정중 / 'မင်း' 친근) 원문에 맞춤. Reply with two sections: '**ဘာသာပြန်**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  beta_feedback_request_ko: (text) =>
    `Draft a Korean email asking beta users for structured feedback after 1-2 weeks of use. Use 해요체. Markdown: '**제목**' (1줄, 24자 이내 — '베타 [N]일째, 어떠세요?' 류), '**본문**' (3 단락: 1) 베타 사용 감사 + 1줄 안부, 2) 3가지만 알려달라고 정중히 — '가장 자주 쓰는 기능 / 가장 헷갈렸던 부분 / 없다면 못 살 1가지', 3) 답하기 쉽게 — 'Reply 한 줄도 OK / 5분 통화도 OK / 짧은 설문 X분'), '**P.S.**' (1줄 — 답해주시면 [작은 리워드]).\n\n베타 / 제품 컨텍스트:\n${text}`,
  translate_ko_to_khmer: (text) =>
    `Translate the Korean text below into natural Khmer (ខ្មែរ). 격식 ('លោក / លោកស្រី' 정중 / 친근 어말) 원문에 맞춤. Reply with two sections: '**ការបកប្រែ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  design_review_doc_ko: (text) =>
    `Build a Korean design review doc for the design described below. Use 해요체. Markdown: '**디자인 한 줄**' (1줄 — 무엇을 / 누구를 위해 / 단계), '**문제 정의**' (2-3줄), '**탐색한 옵션 (3가지)**' (각 'h3: 옵션 + 1줄 설명 + 스크린샷 placeholder + Pros / Cons'), '**선택한 방향**' (1줄 + 1단락 이유), '**Open questions (3 bullets)**' (디자인 리뷰에서 답 받고 싶은 것), '**다음 단계**' (1줄), '**관련 자료**' (bullets).\n\n디자인 컨텍스트:\n${text}`,
  translate_ko_to_lao: (text) =>
    `Translate the Korean text below into natural Lao (ລາວ). 격식 원문에 맞춤. Reply with two sections: '**ການແປ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_call_prep_ko: (text) =>
    `Build a Korean prep doc for a customer contract renewal call. Use 해요체. Markdown: '**계약 한 줄**' (계약사 / 금액 / 만기 / 자동갱신 여부), '**계약 동안의 가치**' (3 bullets — 메트릭 + 케이스), '**Health score / 사용 신호**' (3 bullets — adoption / 활성 사용자 / 마지막 30일 트렌드), '**위험 신호**' (2 bullets — 사용량 감소 / 챔피언 이직 / 경쟁사 이름 언급), '**우리가 미팅에서 협상할 것**' (bullets — 갱신 기간 / 가격 / 추가 모듈), '**상대가 협상할 것**' (bullets — 우리 예상), '**대안 / 양보 가능 vs 불가**' (테이블), '**미팅 후 24시간 안에 보낼 follow-up 초안**' (1단락).\n\n계약 / 사용 데이터:\n${text}`,
  translate_ko_to_mongolian: (text) =>
    `Translate the Korean text below into natural Mongolian (Cyrillic script — Монгол хэл). 격식 ('Та' 정중 / 'чи' 친근) 원문에 맞춤. Reply with two sections: '**Орчуулга**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  public_roadmap_intro_ko: (text) =>
    `Write a Korean intro section for a public product roadmap page. Use 해요체. 솔직 + 겸손한 톤 — '약속이 아니라 방향'임을 명확히. Markdown: '**왜 공개하나요 (1단락)**' (3-4줄 — 신뢰 / 협업 / 기대 관리), '**무엇이 들어있나요**' (bullets — Now / Next / Later 분류 / 사용자 영향), '**무엇이 안 들어있나요 (1단락)**' (2-3줄 — 보안 / 가격 / 기밀 제외), '**여러분이 영향 줄 수 있는 방법**' (3 bullets — 투표 / 댓글 / 인터뷰 신청), '**얼마나 자주 업데이트되나요**' (1줄 — 'X 주마다 새로 정렬'), '**범례 (Now/Next/Later)**' (각 1줄 정의 — '이 분기 / 6개월 안 / 1년 안').\n\n로드맵 컨텍스트:\n${text}`,
  translate_ko_to_uzbek: (text) =>
    `Translate the Korean text below into natural Uzbek (Oʻzbek). Latin script default. 격식 ('Siz' 정중 / 'sen' 친근) 원문에 맞춤. Reply with two sections: '**Tarjima**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  board_meeting_prep_doc_ko: (text) =>
    `Build a Korean board meeting prep doc — sent to board members 1 week before the meeting. Use 합쇼체. Markdown: '**미팅 한 줄 (1줄)**' (목적 + 핵심 결정 1-2개), '**Agenda (테이블)**' ('시간 | 항목 | 진행자 | 결정 / 토론'), '**한 줄 회사 상태**' (1줄 — 'on track / at risk + 1줄 근거'), '**핵심 메트릭 5개 (테이블)**' ('KPI | 현재 | 목표 | 전분기'), '**잘 된 것 3가지 / 안 된 것 3가지**' (각 bullets), '**보드에 요청할 결정 (numbered)**' (각 '결정 사항 / 옵션 / 우리 추천 / 영향'), '**Open questions to discuss**' (bullets), '**부록**' (bullets — 첨부 자료 placeholder).\n\n분기 데이터:\n${text}`,
  translate_ko_to_kazakh: (text) =>
    `Translate the Korean text below into natural Kazakh (Қазақ тілі). Cyrillic 또는 Latin script — 입력 맥락 추론. 격식 ('Сіз' 정중 / 'сен' 친근) 원문에 맞춤. Reply with two sections: '**Аударма**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  employee_handbook_intro_ko: (text) =>
    `Write a Korean employee handbook intro section for the company described below. Use 해요체. Markdown: '**환영합니다 (1단락)**' (3-4줄 — 따뜻한 환영 + 핸드북 이용법 1줄), '**우리 회사 한 줄 (미션)**' (1줄), '**우리가 믿는 것 (가치 3-5개)**' (각 '### 가치명 — 1줄 정의 + 1줄 행동 예시'), '**일하는 방식 (3 bullets)**' (회의 / 의사결정 / 도구), '**필수 정책 안내 링크**' (bullets — 휴가 / 보안 / 윤리 / 채용 / 평가 — 각 1줄 + placeholder), '**모르겠을 때**' (1줄 — Slack 채널 + 사람).\n\n회사 / 단계:\n${text}`,
  translate_ko_to_georgian: (text) =>
    `Translate the Korean text below into natural Georgian (ქართული). Georgian script 정확히. 격식 ('თქვენ' 정중 / 'შენ' 친근) 원문에 맞춤. Reply with two sections: '**თარგმანი**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  sales_demo_followup_email_ko: (text) =>
    `Draft a Korean sales demo follow-up email — sent within 24 hours of a product demo. Use 해요체. Markdown: '**제목**' (1줄, 25자 이내 — '[제품명] 데모 follow-up + 질문 답변'), '**본문**' (4 단락: 1) 시간 감사 + 데모에서 가장 기억 남는 1줄, 2) 그쪽이 물어본 질문에 대한 답 — 1-2개 핵심, 3) 우리가 약속한 자료 / 사례 / 트라이얼 링크 (구체적), 4) 다음 단계 제안 — 'X 결정에 30분 더 깊은 대화 어떠세요'), '**P.S.**' (1줄 — 데모 녹화 링크 또는 추가 자료).\n\n데모 / 고객:\n${text}`,
  translate_ko_to_armenian: (text) =>
    `Translate the Korean text below into natural Armenian (Հայերեն). Armenian script 정확히. 격식 ('Դուք' 정중 / 'դու' 친근) 원문에 맞춤. Reply with two sections: '**Թարգմանություն**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  contractor_offer_email_ko: (text) =>
    `Draft a Korean contractor offer email (계약직 / 프리랜서 영입). Use 해요체. 정직원이 아니라는 점을 분명히 + 따뜻하게. Markdown: '**제목**' (1줄, 24자 이내 — '[프로젝트명] 계약직 제안' 류), '**본문**' (4 단락: 1) 만나서 반가웠다 + 본인 추천한 1줄, 2) 제안 — 역할 / 기간 / 시간 / 보수 / 결제 주기 — 정확히, 3) 산출물 / 기대치 / 의사결정 범위, 4) 다음 단계 — '관심 있으시면 ~까지 답장 + 짧은 SOW 보내드릴게요'), '**참고**' (1줄 — 비밀유지 / 지적재산권 등 표준 조항 안내).\n\n프로젝트 / 조건:\n${text}`,
  translate_ko_to_amharic: (text) =>
    `Translate the Korean text below into natural Amharic (አማርኛ). Ge'ez script 정확히. 격식 ('እርስዎ' 정중 / 'አንተ/አንቺ' 친근) 원문에 맞춤. Reply with two sections: '**ትርጉም**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  gdpr_dsr_response_ko: (text) =>
    `Draft a Korean response to a GDPR Data Subject Request (DSR) — access / erasure / portability / rectification request. Use 합쇼체. 30일 안 응답 의무 의식. Markdown: '**제목**' (1줄 — 'GDPR Data Subject Request 응답 — Ref #NNNN'), '**본문**' (4 단락: 1) 요청 수신 확인 + 요청 종류 명시 + 처리 시한 안내, 2) 본인 확인 절차 — 신원 확인 어떻게 진행, 3) 응답 — access면 데이터 사본 / erasure면 삭제 처리 결과 + 제외 항목 (법적 보관 의무) / portability면 포맷 / rectification면 수정 결과, 4) 추가 권리 안내 + 감독기관 신고권 안내), '**서명**' (DPO 또는 책임자 + 연락처).\n\n요청 종류 + 사용자 데이터 컨텍스트:\n${text}`,
  final_milestone_celebration_email_ko: (text) =>
    `Draft a Korean internal celebration email for a major milestone — sent to the whole team. Use 해요체. 따뜻하고 진심 어린 톤 — 가식 / 인플레이션된 칭찬 금지. Markdown: '**제목**' (1줄, 28자 이내 — '[마일스톤] 달성! 다 함께 축하해요' 류), '**본문**' (4 단락: 1) 한 줄 — '오늘 우리는 [마일스톤]을 달성했습니다', 2) 이게 왜 중요한지 1단락 — 회사 / 사용자 / 우리에게 어떤 의미, 3) 호명 + 구체적 기여 — 가짜 이름 만들지 말기, 입력에 있는 이름만, 각 '@이름 — 무엇을 한 1줄', 4) 다음 — '다음 마일스톤은 ... / 오늘은 잠시 멈춰서 자축'), '**감사**' (1줄 — 모두에게).\n\n마일스톤 + 기여자:\n${text}`,
  milestone_complete_announcement_ko: (text) =>
    `Write a Korean public announcement for a completed major milestone (e.g., 1000번째 출시 / 1M ARR / 신제품 GA). Use 합쇼체. 솔직 + 작은 자축 + 다음 약속. Markdown: '**제목**' (1줄, 30자 이내 — '[회사명], [마일스톤] 달성 — YYYY-MM-DD'), '**본문**' (4 단락: 1) 한 줄로 무엇을 / 언제 / 누구 덕분에, 2) 우리가 어떻게 여기까지 왔는지 — 짧은 history 1단락, 3) 이 마일스톤이 사용자 / 시장에 어떤 의미, 4) 다음 약속 1줄 — '다음 마일스톤은 [무엇] 이고, 그 길에 함께해주세요'), '**감사 (1줄)**' (사용자 / 팀 / 투자자 / 커뮤니티 — 진심으로). 이모지는 제목에 1개 이내.\n\n마일스톤 컨텍스트:\n${text}`,
  translate_ko_to_albanian: (text) =>
    `Translate the Korean text below into natural Albanian (Shqip). 격식 ('Ju' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Përkthimi**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  competitor_battle_card_ko: (text) =>
    `Build a Korean sales battle card for the competitor described below — used by sales reps in live calls. Use 합쇼체. 1 page, sales-rep 시야 우선. Markdown: '**경쟁사 한 줄**' (이름 / 본사 / 자금 단계 / ICP 1줄), '**그들의 강점 (3 bullets)**' (객관적, 빈말 금지), '**그들의 약점 / 우리가 이기는 지점 (3 bullets)**' (구체적 사례 + 데이터 + 고객 인용), '**자주 듣는 비교 질문 + 우리 답변**' (3-5쌍, 각 'Q: ... / A: ...' 30초 답변), '**가격 비교**' (1줄 — 'X달러 vs 우리 Y달러, ... 차이'), '**그들이 우리를 공격할 때**' (2 bullets — 그들이 자주 하는 말 + 우리 반박 1줄), '**고객 인용 (사용 가능 1개)**' (1단락 — 이전 경쟁사 → 우리 전환 사례).\n\n경쟁사 / 컨텍스트:\n${text}`,
  translate_ko_to_macedonian: (text) =>
    `Translate the Korean text below into natural Macedonian (Македонски). Cyrillic script. 격식 ('Вие' 정중 / 'ти' 친근) 원문에 맞춤. Reply with two sections: '**Превод**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  incident_postmortem_blameless_ko: (text) =>
    `Write a Korean blameless incident postmortem from the incident notes below. Use 합쇼체. 누구의 잘못이 아니라 '시스템이 어떻게 이런 행동을 허용했는가' 관점 유지. Markdown: '**사건 한 줄**' (1줄 — 무엇이 / 언제 / 누가 영향), '**영향 (Impact)**' (3 bullets — 사용자 수 / 다운타임 / 매출 / 평판), '**타임라인 (테이블)**' ('시간(KST) | 이벤트 | 행위자(역할만)'), '**근본 원인 (Root Cause)**' (1단락 — 기술적 + 조직적, 책임자 이름 금지), '**왜 이렇게 됐나 — 5 Whys**' (numbered), '**잘 된 것**' (2-3 bullets — 빠른 감지 / 좋은 의사결정), '**잘 안 된 것**' (2-3 bullets — 시스템 관점), '**액션 아이템 (테이블)**' ('액션 | 담당팀 | 시한 | 우선순위'), '**얻은 교훈 (Lessons)**' (3 bullets — 일반화).\n\n사건 노트:\n${text}`,
  translate_ko_to_estonian: (text) =>
    `Translate the Korean text below into natural Estonian (eesti keel). 격식 ('Teie' 정중 / 'sina' 친근) 원문에 맞춤. Reply with two sections: '**Tõlge**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  meeting_decision_log_ko: (text) =>
    `Build a Korean meeting decision log entry — one row per decision, for archival/searchability. Use 합쇼체. Markdown: '**Decision ID + 한 줄**' (1줄 — 'DEC-NNNN: ...'), '**날짜 / 미팅**' (1줄), '**참석자 (역할)**' (bullets — 이름 + 역할), '**배경 (Why now)**' (2-3줄 — 왜 이 결정이 지금 필요), '**고려된 옵션 (테이블)**' ('옵션 | Pros | Cons | 영향'), '**선택된 옵션 + 이유**' (1단락 — 무엇을 / 왜), '**반대 의견 / 우려**' (bullets — 누가 / 무엇 / 어떻게 mitigate), '**Reversible?**' (1줄 — Yes/No + 되돌리는 비용), '**액션 (담당 / 시한)**' (bullets), '**Revisit 시점**' (1줄 — '이 결정은 X 시점에 재검토').\n\n미팅 노트:\n${text}`,
  translate_ko_to_latvian: (text) =>
    `Translate the Korean text below into natural Latvian (latviešu valoda). 격식 ('Jūs' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Tulkojums**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  okr_q3_alignment_doc_ko: (text) =>
    `Build a Korean cross-team OKR alignment doc — circulated 2 weeks before the quarter starts. Use 합쇼체. 팀끼리 OKR 의존성 / 충돌 / 빈틈을 발견하기 위함. Markdown: '**분기 / 회사 한 줄**' (1줄 — 'Q[X] YYYY, 회사가 집중하는 1줄'), '**회사 OKR (상기)**' (bullets — Objective + KRs), '**팀별 KR 매핑 (테이블)**' ('팀 | KR이 회사 어떤 O에 연결 | 이 KR을 위해 다른 팀에 필요한 것 | 다른 팀에 줄 수 있는 것'), '**의존성 그래프 (텍스트)**' (5-7줄 — 'A팀 KR2는 B팀이 X를 ~까지 끝내야 가능'), '**충돌 / 빈틈**' (bullets — 같은 자원 경쟁 / 누구도 안 보는 영역), '**해결 미팅 (제안)**' (bullets — 누가 / 언제 / 무엇 결정), '**최종 확정 시한**' (1줄).\n\n팀 OKR 초안 모음:\n${text}`,
  translate_ko_to_lithuanian: (text) =>
    `Translate the Korean text below into natural Lithuanian (lietuvių kalba). 격식 ('Jūs' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Vertimas**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_kickoff_email_ko: (text) =>
    `Draft a Korean customer kickoff email — sent within 24 hours of contract signing to formally start the onboarding. Use 해요체. 따뜻 + 명확. Markdown: '**제목**' (1줄, 26자 이내 — '환영합니다! [고객사] 킥오프 안내' 류), '**본문**' (5 단락: 1) 계약 환영 + 우리 모두 신난다는 1줄, 2) 누가 / 무슨 역할 — CSM / 솔루션 엔지니어 / Exec sponsor, 각 이름 + 이메일 + 본인 1줄, 3) 첫 30일 로드맵 — 1주차 / 2주차 / 3-4주차 단계별, 각 1줄, 4) 당장 필요한 것 (고객 쪽) — 'X 까지 ~ 보내주시면 좋아요' bullets, 5) 첫 미팅 일정 후보 3개 + 무엇 다룰지 1줄), '**참고 자료**' (bullets — 도움 문서 / 슬랙 채널 / 상태 페이지 placeholder).\n\n고객 / 계약 컨텍스트:\n${text}`,
  translate_ko_to_slovenian: (text) =>
    `Translate the Korean text below into natural Slovenian (slovenščina). 격식 ('Vi' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Prevod**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  engineering_design_doc_short_ko: (text) =>
    `Build a Korean short engineering design doc (1-2 page max) for the feature described below. Use 합쇼체. 큰 시스템 변경 X — 1주 안에 만들 수 있는 작은 기능용. Markdown: '**한 줄 (Tagline)**' (1줄 — 무엇을 / 누구를 위해), '**문제 (Why)**' (3-4줄), '**제안 (What)**' (3-5줄 + 작은 ASCII 다이어그램 또는 placeholder), '**API 변경**' (bullets — 추가 / 변경 / 삭제 endpoint 또는 함수), '**DB / 스토리지 변경**' (bullets — 새 테이블 / 컬럼 또는 'none'), '**대안 (1 단락)**' (왜 안 골랐는지 1-2줄), '**위험 / Open questions**' (bullets — 최대 3), '**롤아웃**' (1줄 — feature flag / 단계).\n\n기능 컨텍스트:\n${text}`,
  translate_ko_to_slovak: (text) =>
    `Translate the Korean text below into natural Slovak (slovenčina). 격식 ('Vy' 정중 / 'ty' 친근) 원문에 맞춤. Reply with two sections: '**Preklad**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  partnership_proposal_email_ko: (text) =>
    `Draft a Korean partnership proposal email — cold outbound to a potential partner company. Use 해요체. 자기 자랑 톤 X, 'win-win' 시각 강조. Markdown: '**제목**' (1줄, 26자 이내 — '[우리회사] × [상대회사] 파트너십 제안'), '**본문**' (4 단락: 1) 1-2줄 — 본인 / 우리 회사 한 줄 + 왜 지금 연락, 2) 우리가 본 그쪽의 강점 + 우리 강점 — 합쳤을 때 시너지 1단락, 3) 구체 제안 옵션 2-3개 — 'A: 공동 기술 통합 / B: 공동 마케팅 / C: 리셀러' 등, 각 1줄 + 예상 효과, 4) 30분 짧은 탐색 미팅 제안 + 일정 후보 3개), '**P.S.**' (1줄 — '시간 없으시면 [짧은 자료 링크] 보고 결정해 주셔도 됩니다').\n\n상대 회사 / 우리 컨텍스트:\n${text}`,
  translate_ko_to_croatian: (text) =>
    `Translate the Korean text below into natural Croatian (hrvatski). 격식 ('Vi' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Prijevod**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  engineering_hiring_loop_doc_ko: (text) =>
    `Build a Korean engineering hiring loop doc — given to interviewers before a candidate's on-site. Use 합쇼체. Markdown: '**후보자 한 줄**' (이름 / 현재 회사 / 지원 포지션 / 레벨), '**왜 이 후보를 본 것**' (2-3줄 — 리쿠르터 / 본인 / 추천인 노트), '**평가 루프 (테이블)**' ('시간 | 인터뷰어 | 평가 영역 | 질문 종류'), '**각 인터뷰어 가이드**' (bullets — 영역별로 어떤 신호를 봐야 하는지, 어떻게 채점하는지 1줄), '**Calibration 노트**' (1단락 — 이 레벨에서 보통 받는 답변 + 이 후보가 다를 수 있는 지점), '**Debrief 미팅**' (1줄 — 시간 / 누가 참석 / 결정 시한), '**Reference 체크 메모**' (bullets — 누가 / 무엇을 물어볼지).\n\n후보 / 포지션:\n${text}`,
  translate_ko_to_serbian_latin: (text) =>
    `Translate the Korean text below into natural Serbian — Latin script (srpski, latinica). 격식 ('Vi' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Prevod**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_advocacy_program_intro_ko: (text) =>
    `Write a Korean intro email + program description for launching a customer advocacy program (열성 고객 모임). Use 해요체. 'VIP 클럽' 같은 가벼움 X, 'co-builders' 무게 있는 톤. Markdown: '**제목**' (1줄, 28자 이내 — '[프로그램명] 첫 멤버로 모십니다'), '**왜 시작했는지 (1단락)**' (3-4줄 — 우리 사용자가 어떤 것을 깊이 아는지, 우리가 무엇을 함께 만들고 싶은지), '**프로그램이 주는 것 (bullets)**' (3-4개 — 사전 베타 / 직접 피드백 / 분기 미팅 / 사례 노출 — 빈말 X, 실제), '**프로그램이 요구하는 것 (bullets)**' (3개 — 분기 1회 미팅 / 베타 피드백 / 사례 공개 동의 — 명확히), '**참여 방법**' (1줄 — 'X 폼 / Y월 D일 마감').\n\n프로그램 컨텍스트:\n${text}`,
  translate_ko_to_bosnian: (text) =>
    `Translate the Korean text below into natural Bosnian (bosanski). 격식 ('Vi' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Prijevod**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  product_principles_doc_ko: (text) =>
    `Draft a Korean product principles doc — short, opinionated, posted in #product Slack as a pinned message. Use 해요체. 5-7개 원칙. 각 원칙은 '하지 마라' 측과 '해라' 측이 모두 있어야 진짜 원칙. Markdown: '**왜 원칙이 필요한가요 (1단락)**' (2-3줄), '**원칙 (각 원칙 — h3 + 1줄 + Do / Don't 2-3 bullets + 사례 1줄)**', '**원칙이 충돌할 때**' (1단락 — 우선순위 또는 'PM이 결정'), '**Revisit**' (1줄 — '6개월마다 재검토').\n\n제품 / 회사 컨텍스트:\n${text}`,
  translate_ko_to_montenegrin: (text) =>
    `Translate the Korean text below into natural Montenegrin (crnogorski). Latin script default. 격식 ('Vi' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Prevod**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  growth_marketing_funnel_audit_ko: (text) =>
    `Build a Korean growth marketing funnel audit doc — for a CMO / 마케팅 리드 reviewing why pipeline 또는 매출이 정체되었는지. Use 합쇼체. 솔직 + 구체적. Markdown: '**한 줄 결론**' (1줄 — 'X 단계에서 Y% drop, 이유는 Z'), '**퍼널 단계별 메트릭 (테이블)**' ('단계 | 정의 | 이번 분기 | 전 분기 | Δ | benchmark vs 우리'), '**가장 큰 누수 3곳**' (각 'h3 + 데이터 + 가설 + 검증할 실험 1개'), '**Quick wins (1주 안 시도 가능)**' (3 bullets), '**구조적 변경 (분기 단위)**' (3 bullets — 채널 / 메시지 / 자동화), '**필요한 자원**' (1줄 — 사람 / 예산 / 도구).\n\n퍼널 데이터:\n${text}`,
  translate_ko_to_maltese: (text) =>
    `Translate the Korean text below into natural Maltese (Malti). 격식 ('Inti' 친근 / 'Intom' 정중) 원문에 맞춤. Reply with two sections: '**Traduzzjoni**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_comms_layoff_announcement_ko: (text) =>
    `Draft a Korean internal layoff announcement — sent by the CEO to the whole company. Use 합쇼체. 직설 + 진심 + 책임. 가식 / 'reorg' / 'restructuring' 같은 완곡 어구 금지. Markdown: '**제목**' (1줄, 22자 이내 — '회사 정리해고 안내 — YYYY-MM-DD'), '**본문**' (5 단락 + 모든 단락 직설: 1) 1-2줄 — '오늘 [N]명을 정리해고했습니다. 이 결정은 제가 내렸습니다.', 2) 왜 — 회사 상황 / 시장 / 우리가 한 잘못 — 회피 없이, 3) 누가 영향 — 어느 팀 / 어느 지역 / 어떻게 알게 되는지 시한, 4) 떠나는 분들께 제공 — 퇴직금 / 의료 / 비자 / job placement, 5) 남는 분들께 — 우리가 어디로 가는지 / 다음 all-hands 시점), '**Q&A는 [시간]에 진행합니다**' (1줄).\n\n회사 / 결정 컨텍스트:\n${text}`,
  translate_ko_to_icelandic: (text) =>
    `Translate the Korean text below into natural Icelandic (Íslenska). 격식 ('þér' 매우 정중 — 거의 안 씀 / 'þú' 표준) 원문에 맞춤. Reply with two sections: '**Þýðing**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_referral_program_intro_ko: (text) =>
    `Write a Korean customer referral program intro email + landing page copy. Use 해요체. 사기처럼 들리지 않게 — 보상 명확 + 시간 명확. Markdown: '**제목 (이메일)**' (1줄, 24자 이내 — '주변에 소개해주세요. 양쪽 다 [보상]'), '**본문 (이메일)**' (3 단락: 1) 1줄 — 우리 제품을 좋아해주셔서 감사 + 다음 한 줄, 2) 프로그램 — 추천인이 가입 후 X 액션 완료하면 양쪽 다 [보상] — 명확히, 3) 추천 방법 — 링크 / 코드 1줄), '**랜딩 페이지 헤드라인**' (1줄), '**랜딩 3 bullets**' (어떻게 작동 / 보상 / FAQ 링크), '**조건 (작은 글씨)**' (bullets — 자격 / 제외 / 보상 지급 시점).\n\n프로그램 컨텍스트:\n${text}`,
  translate_ko_to_welsh: (text) =>
    `Translate the Korean text below into natural Welsh (Cymraeg). 격식 ('chi' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Cyfieithiad**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  sales_negotiation_concession_ladder_ko: (text) =>
    `Build a Korean sales negotiation concession ladder doc — used internally before entering a price negotiation. Use 합쇼체. Markdown: '**거래 한 줄**' (고객사 / 제품 / 시작 가격 / 만기), '**우리 최대 안 (Best Case)**' (1줄 — 가격 + 조건), '**우리 walk-away**' (1줄 — 'X 이하 / Y 조건 없으면 안 함'), '**양보 사다리 (테이블)**' ('단계 | 우리가 양보 | 우리가 요구 받는 것 | 누구 결재 필요'), '**상대가 요청할 가능성 높은 것 + 우리 답변**' (3-5쌍), '**ZOPA (Zone of Possible Agreement)**' (1줄 — 양쪽 walk-away 사이), '**비가격 양보 (가치 있지만 cost가 작은 것)**' (bullets — 컨설팅 시간 / 빠른 onboarding / 사례 노출), '**시간 압박 활용**' (1줄 — 분기 마감 / 우리 / 그쪽 deadline).\n\n거래 / 고객 컨텍스트:\n${text}`,
  translate_ko_to_irish: (text) =>
    `Translate the Korean text below into natural Irish (Gaeilge). 격식 ('sibh' 정중 / 'tú' 친근) 원문에 맞춤. Reply with two sections: '**Aistriúchán**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  quarterly_growth_review_email_ko: (text) =>
    `Draft a Korean quarterly growth review email — sent by Head of Growth to leadership team. Use 합쇼체. Markdown: '**제목**' (1줄, 28자 이내 — 'Q[X] Growth Review — 한 줄 요약'), '**본문**' (5 단락: 1) 한 줄 결론 + 신호등 (Green/Yellow/Red), 2) 핵심 메트릭 (4-5개 — 각 'X: A → B, 목표 C, 결론'), 3) 잘 된 실험 / 채널 — 2-3개, 무엇을 / 왜 작동 / 어떻게 확장, 4) 안 된 실험 / 채널 — 2-3개, 무엇을 / 왜 안 됨 / 멈출지 계속할지, 5) 다음 분기 베팅 3가지 + 필요한 자원), '**부록**' (bullets — 메트릭 dashboard / 실험 결과 raw).\n\n분기 데이터:\n${text}`,
  translate_ko_to_scottish_gaelic: (text) =>
    `Translate the Korean text below into natural Scottish Gaelic (Gàidhlig). 격식 ('sibh' 정중 / 'thu' 친근) 원문에 맞춤. Reply with two sections: '**Eadar-theangachadh**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  pm_weekly_writeup_to_eng_ko: (text) =>
    `Draft a Korean weekly writeup from PM to the engineering team — posted in #eng-product Slack on Friday. Use 해요체. 짧고 친근, 디테일 가득. Markdown: '**이번 주 한 줄**' (1줄 — 'X 출시 / Y 결정 / Z 막힘'), '**출시 / 머지된 것**' (3 bullets — 무엇 / 누가 / 영향), '**우리가 결정한 것 + 왜**' (2 bullets), '**막힌 것 / 도움 필요한 것**' (2 bullets — 구체적 — '@사람 X 까지 ~ 가능?'), '**다음 주 우선순위 (상위 3개)**' (numbered), '**사용자 / 데이터에서 배운 것**' (1-2 bullets — '이번 주 사용자가 ~ 했어요'), '**감사**' (1줄 — 도움 준 사람 호명).\n\n이번 주 컨텍스트:\n${text}`,
  translate_ko_to_catalan: (text) =>
    `Translate the Korean text below into natural Catalan (català). 격식 ('vostè' 매우 정중 / 'vós' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Traducció**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  incident_communications_press_ko: (text) =>
    `Draft a Korean press / external statement about an ongoing or just-resolved incident — for journalists / 비즈니스 매체. Use 합쇼체. 사실 + 인정 + 사용자 보호 + 다음 단계. 변명 / 'we cannot disclose' 회피 금지. Markdown: '**제목**' (1줄, 32자 이내 — '[회사명] 사고 / 보안 사건 안내 — YYYY-MM-DD'), '**본문**' (4 단락: 1) 1-2줄 — 무엇이 / 언제 / 누가 영향 (정확히 / 추정 X), 2) 우리가 무엇을 했는지 — 감지 시각 / 대응 / 복구 — 시간순, 3) 사용자에게 미치는 영향 + 우리가 사용자를 위해 한 행동 — 비밀번호 강제 reset / 알림 / 보상, 4) 우리가 알게 된 / 알아내야 할 것 + 다음 update 시점 + 연락처), '**프레스 문의**' (1줄 — 이름 + 이메일).\n\n사건 + 사실 컨텍스트:\n${text}`,
  translate_ko_to_basque: (text) =>
    `Translate the Korean text below into natural Basque (euskara). 격식 ('zu' 정중 / 'hi' 친근 — 거의 안 씀) 원문에 맞춤. Reply with two sections: '**Itzulpena**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_health_review_call_ko: (text) =>
    `Build a Korean customer health review call prep doc — for CSM doing a monthly check-in with mid-market customer. Use 해요체. Markdown: '**고객 한 줄**' (회사 / 산업 / 우리와 X개월, 계약 금액), '**Health Score**' (1줄 — 신호등 + 한 줄 근거), '**사용 트렌드 (3 bullets)**' (DAU/WAU/MAU / 적극 사용 기능 / 30일 미사용 기능), '**티켓 트렌드**' (1줄 — 지난 30일 N건, 주제 패턴 1줄), '**리스크 신호**' (3 bullets — adoption 정체 / 챔피언 이직 / 사용량 감소), '**기회 신호**' (2 bullets — 새 use case / 추가 좌석 가능성), '**미팅 어젠다 (30분)**' (numbered — '안부 5분 / health 리뷰 10분 / 이슈 토론 10분 / 다음 30일 5분'), '**미팅에서 묻고 싶은 3가지**' (questions), '**미팅 후 follow-up 초안**' (1단락).\n\n고객 / 사용 데이터:\n${text}`,
  translate_ko_to_galician: (text) =>
    `Translate the Korean text below into natural Galician (galego). 격식 ('vostede' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Tradución**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  marketing_brief_template_ko: (text) =>
    `Build a Korean marketing brief template — filled out by PM / 마케팅 매니저 before a campaign kickoff. Use 합쇼체. Markdown: '**캠페인 한 줄**' (1줄 — 무엇을 / 누구에게 / 언제까지), '**목표 (정량)**' (bullets — '리드 X개 / 가입 Y / 매출 Z'), '**타겟 페르소나**' (2-3 bullets — 직책 / 회사 크기 / 페인), '**메시지 (1단락)**' (3-4줄 — 우리가 그들에게 하고 싶은 한 마디), '**핵심 가치 제안 (3 bullets)**' (왜 우리 / 왜 지금 / 우리만 가능한 것), '**채널 + 자산**' (테이블 — '채널 | 자산 종류 | 담당 | 시한'), '**예산**' (1줄), '**측정 방법**' (bullets — 어떤 메트릭 / 어디서 / 누가 report), '**위험 / 의존성**' (2 bullets), '**Kill criteria**' (1줄 — 'X 기준 못 넘기면 중단').\n\n캠페인 컨텍스트:\n${text}`,
  translate_ko_to_yoruba: (text) =>
    `Translate the Korean text below into natural Yoruba (Èdè Yorùbá). 격식 ('ẹ' 정중 / 'o' 친근) 원문에 맞춤. Reply with two sections: '**Ìtumọ̀**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  engineering_team_charter_ko: (text) =>
    `Draft a Korean engineering team charter — pinned in the team's home channel, used for onboarding new engineers + alignment. Use 해요체. Markdown: '**팀 한 줄**' (1줄 — 우리 팀이 회사에서 어떤 책임을 갖는지), '**우리가 책임지는 영역 (System / Surface)**' (bullets — 서비스 / 코드베이스 / SLO), '**우리가 책임지지 않는 영역 (with 누구에게 위임)**' (bullets — 명확히), '**현재 미션 (이번 분기)**' (1단락 + 3 measurable bullets), '**일하는 방식**' (bullets — 미팅 / 코드리뷰 / on-call / Sprint), '**도구 / 다이어그램**' (bullets + placeholder for diagram link), '**우리 팀과 일하려면**' (1단락 — 다른 팀이 우리에게 부탁할 때 어떤 채널 / 양식 / SLA), '**팀원 + 역할**' (테이블 — '이름 | 직책 | 주력 영역 | 백업').\n\n팀 컨텍스트:\n${text}`,
  translate_ko_to_igbo: (text) =>
    `Translate the Korean text below into natural Igbo (Asụsụ Igbo). 격식 ('ụnụ' 정중 또는 복수 / 'ị' 친근) 원문에 맞춤. Reply with two sections: '**Ntụgharị Asụsụ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_first_30day_review_ko: (text) =>
    `Build a Korean customer first 30-day review doc — CSM uses this to review whether a new customer is on track to value. Use 해요체. Markdown: '**고객 한 줄**' (회사 / 산업 / 계약일 / 시작일), '**계약 시 약속한 것**' (3 bullets — 계약 단계에서 우리가 약속한 결과), '**30일 안 약속**' (bullets — onboarding 단계에서의 약속), '**현재 (D+30) 실제**' (각 약속 옆에 'OK / 진행중 / 못 함' + 1줄 이유), '**Time to first value (TTFV)**' (1줄 — 며칠, 우리 평균 vs 이번), '**Adoption 신호**' (3 bullets — 로그인 / 핵심 기능 X회 / 팀원 N명), '**위험 / 기회**' (각 2 bullets), '**다음 30일 액션 (테이블)**' ('액션 | 누구 (우리/고객) | 시한'), '**Exec sponsor 노출 필요?**' (1줄 — Yes/No + 이유).\n\n고객 / 진행 데이터:\n${text}`,
  translate_ko_to_hausa: (text) =>
    `Translate the Korean text below into natural Hausa (Harshen Hausa). 격식 ('ku' 정중 또는 복수 / 'ka/ki' 친근 남/여) 원문에 맞춤. Reply with two sections: '**Fassara**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  executive_offsite_agenda_ko: (text) =>
    `Draft a Korean executive offsite agenda — 2-day leadership team retreat (보통 분기마다). Use 합쇼체. 2일 동안 결정 / 정렬 / 휴식을 균형 있게. Markdown: '**Offsite 한 줄**' (1줄 — 시기 / 장소 / 핵심 목표 1개), '**참석자 (역할)**' (bullets), '**Pre-work (1주 전 보낼 것)**' (bullets — 사전 읽기 / 준비 답변), '**Day 1 (테이블)**' ('시간 | 세션 | 진행자 | 결과물'), '**Day 2 (테이블)**' (동일 형식), '**탐색 안 할 토픽 (parking lot)**' (bullets — 다음 offsite로), '**의사결정 방식**' (1줄 — 'CEO 최종 결정 / 합의 / 표결'), '**준비물**' (bullets — 화이트보드 / 슬랙 / 식사 / 휴식), '**Offsite 후 액션 시한**' (1줄 — 'Decision doc는 ~까지 / 사내 공유는 ~까지').\n\nOffsite 목적 / 컨텍스트:\n${text}`,
  translate_ko_to_zulu: (text) =>
    `Translate the Korean text below into natural Zulu (isiZulu). 격식 ('nina' 정중 또는 복수 / 'wena' 친근) 원문에 맞춤. Reply with two sections: '**Ukuhumusha**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  quarterly_engineering_planning_ko: (text) =>
    `Build a Korean quarterly engineering planning doc — written by Eng Lead in the 마지막 2주 of 전 분기. Use 합쇼체. Markdown: '**한 줄 (이번 분기)**' (1줄 — '집중하는 것 + 안 하는 것'), '**회사 분기 OKR 인용**' (bullets — 회사 O와 그에 연결된 KR), '**Eng O + KRs**' (numbered — 측정 가능), '**프로젝트 (3-5개)**' (테이블 — '프로젝트 | 회사 KR 연결 | 담당팀 | 인원 | 완료 정의 | 위험'), '**Engineering health 투자 (20-30%)**' (bullets — 테크 부채 / migration / 인프라), '**On-call / 운영 부담 추정**' (1줄 — '주당 X명 / 위험 영역'), '**다른 팀 의존성 (테이블)**' ('우리가 의존 | 그쪽 commit?'), '**위험 (Top 3)**' (bullets — 위험 + 완화), '**확정 시한**' (1줄).\n\n분기 컨텍스트 / 인풋:\n${text}`,
  translate_ko_to_xhosa: (text) =>
    `Translate the Korean text below into natural Xhosa (isiXhosa). 격식 ('nina' 정중 또는 복수 / 'wena' 친근) 원문에 맞춤. Reply with two sections: '**Inguqulelo**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_pmf_survey_ko: (text) =>
    `Build a Korean PMF (Product-Market Fit) survey — Sean Ellis 방법론 기반, sent to active users. Use 해요체. Markdown: '**제목 (이메일)**' (1줄, 22자 이내 — '[제품명], 짧은 5분 질문'), '**본문 (이메일)**' (2 단락 — 시간 부탁 + 보상 + 익명 안내), '**설문 질문 (numbered)**' (1) '[제품] 을 더 이상 못 쓰게 되면 어떤 기분일까요?' — 매우 실망 / 약간 실망 / 실망 안 함 / 이미 안 씀, 2) '어떤 종류의 사람에게 [제품]이 가장 도움이 될까요?' (open), 3) '[제품]이 주는 핵심 가치는 무엇인가요?' (open), 4) '어떻게 개선할 수 있을까요?' (open), 5) NPS — 0-10 + 이유, 6) 직책 / 회사 크기 / 산업 (분석용)), '**해석 가이드 (내부)**' (1단락 — '매우 실망 X% 가 40% 넘으면 PMF 신호').\n\n제품 / 분석 컨텍스트:\n${text}`,
  translate_ko_to_pashto: (text) =>
    `Translate the Korean text below into natural Pashto (پښتو). RTL 흐름. 격식 ('تاسو' 정중 / 'ته' 친근) 원문에 맞춤. Reply with two sections: '**ژباړه**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  pricing_proposal_internal_ko: (text) =>
    `Draft a Korean internal pricing proposal doc — proposed by Product/Finance to leadership before announcing a price change. Use 합쇼체. Markdown: '**제안 한 줄**' (1줄 — '현재 X → 제안 Y, 이유 Z'), '**현재 가격 + 시장 비교 (테이블)**' ('SKU | 현재 | 우리 변화 | 경쟁사 A | 경쟁사 B'), '**왜 변경하나요 (Why now)**' (3 bullets — 시장 / 가치 / cost), '**예상 영향 — 매출**' (1단락 + 시나리오 3개 — Optimistic / Base / Pessimistic), '**예상 영향 — 고객 churn**' (1단락 — 가격 변경 후 N% 이탈 추정 + 그랜드파더링 계획), '**기존 고객 처리**' (bullets — 신규만 / X개월 grandfather / 강제 이전), '**커뮤니케이션 plan**' (bullets — 누구에게 / 언제 / 채널), '**롤백 plan**' (1줄), '**의사결정 필요한 것 (Yes/No 질문 3개)**' (numbered).\n\n가격 / 분석 컨텍스트:\n${text}`,
  translate_ko_to_sinhala: (text) =>
    `Translate the Korean text below into natural Sinhala (සිංහල). 격식 ('ඔබ' 정중 / 'ඔයා' 친근) 원문에 맞춤. Reply with two sections: '**පරිවර්තනය**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_voice_synthesis_ko: (text) =>
    `Synthesize a Korean Voice-of-Customer (VoC) report from raw customer interview / 지원 티켓 / NPS comment 데이터 below. Use 합쇼체. 객관적 — 데이터에 없는 결론 만들지 말기. Markdown: '**한 줄 요약**' (1줄 — '가장 큰 한 가지 시그널'), '**테마별 정리 (테이블)**' ('테마 | 빈도 (n=) | 강도 | 대표 인용 1줄 | 우리가 할 수 있는 것'), '**가장 자주 들린 페인 (Top 5)**' (numbered — 각 1줄 + 인용 1-2개), '**가장 자주 들린 칭찬 (Top 3)**' (numbered — 강화할 것), '**모순되는 신호**' (2 bullets — 그룹 A는 X를 원하고 B는 반대), '**우리가 다음 할 액션 (제안)**' (bullets — 어떤 팀 / 어떤 결정에 영향), '**데이터의 한계**' (1단락 — 샘플 편향 / 응답률).\n\nVoC raw 데이터:\n${text}`,
  translate_ko_to_punjabi: (text) =>
    `Translate the Korean text below into natural Punjabi (ਪੰਜਾਬੀ — Gurmukhi script). 격식 ('ਤੁਸੀਂ' 정중 / 'ਤੂੰ' 친근) 원문에 맞춤. Reply with two sections: '**ਅਨੁਵਾਦ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  engineering_oncall_handoff_doc_ko: (text) =>
    `Build a Korean engineering on-call handoff doc — written by outgoing on-call engineer at the end of their shift / week. Use 해요체. 짧고 실용. Markdown: '**핸드오프 한 줄**' (1줄 — '이번 주 X건, 미해결 Y건, 주목할 1가지'), '**열린 incident**' (bullets — 'INC-NNNN: 1줄 + 현재 상태 + 다음 액션 + 누구 대기'), '**핫스팟 (자주 알람 울린 영역)**' (3 bullets — 서비스 / 알람 / 패턴 — 다음 oncall 주목), '**조용한 시간 측정 (Quiet hours)**' (1줄 — 우리 SLO 관점), '**진행 중 mitigation**' (bullets — 임시 fix가 살아 있는 곳, 영구 fix 시한), '**이번 주 새로 알게 된 것**' (2 bullets — runbook 업데이트 위치), '**다음 oncall에게**' (1단락 — 친근하게).\n\n주간 oncall 노트:\n${text}`,
  translate_ko_to_marathi: (text) =>
    `Translate the Korean text below into natural Marathi (मराठी). 격식 ('आपण' 정중 / 'तुम्ही' 정중 표준 / 'तू' 친근) 원문에 맞춤. Reply with two sections: '**अनुवाद**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  marketing_campaign_postmortem_ko: (text) =>
    `Build a Korean marketing campaign postmortem — written 2 weeks after campaign end. Use 합쇼체. 솔직 + 데이터 기반. Markdown: '**캠페인 한 줄**' (1줄 — 이름 / 기간 / 총 비용), '**목표 vs 실적 (테이블)**' ('메트릭 | 목표 | 실적 | 달성률'), '**ROI 한 줄**' (1줄 — '비용 X 대비 매출 Y, ROAS Z'), '**잘 된 것 (3 bullets)**' (구체적 — 어떤 채널 / 어떤 메시지가 작동), '**안 된 것 (3 bullets)**' (구체적), '**예상 못한 발견**' (2 bullets — 뜻밖에 잘 된 것 / 뜻밖의 실패), '**다음에 다시 한다면**' (3 bullets — 무엇을 다르게), '**다음 캠페인에 가져가는 것**' (2 bullets — playbook 업데이트 사항).\n\n캠페인 결과:\n${text}`,
  translate_ko_to_telugu: (text) =>
    `Translate the Korean text below into natural Telugu (తెలుగు). 격식 ('మీరు' 정중 / 'నువ్వు' 친근) 원문에 맞춤. Reply with two sections: '**అనువాదం**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  sales_pipeline_review_internal_ko: (text) =>
    `Build a Korean weekly sales pipeline review doc — sales rep + sales lead 1:1 사용. Use 해요체. Markdown: '**한 줄 (이번 주)**' (1줄 — '커밋 X, 베스트 케이스 Y, 클로즈 Z'), '**Top 5 active deal (테이블)**' ('계약사 | 금액 | 단계 | next step | 위험 신호 | 행동'), '**Stuck deal (>2주 같은 단계)**' (bullets — 계약사 / 왜 막힘 / 우리가 할 액션 / kill 여부), '**파이프라인 건강 (수치)**' (3 bullets — 새 lead / 코버리지 / 평균 cycle), '**필요한 도움**' (bullets — '@매니저 X 같이 가주실 수 있나요'), '**다음 주 우선순위 3개**' (numbered), '**개인적인 것 (선택)**' (1줄 — 잘 됨 / 막힘).\n\n파이프라인 데이터:\n${text}`,
  translate_ko_to_kannada: (text) =>
    `Translate the Korean text below into natural Kannada (ಕನ್ನಡ). 격식 ('ನೀವು' 정중 / 'ನೀನು' 친근) 원문에 맞춤. Reply with two sections: '**ಅನುವಾದ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  team_meeting_async_format_ko: (text) =>
    `Convert a Korean recurring team meeting (주간 standup / 분기 리뷰) into an async written format — so the team can reclaim the synchronous time. Use 해요체. Markdown: '**기존 미팅**' (1줄 — 이름 / 빈도 / 시간 / 참석자 수), '**왜 async로 옮기나요**' (1단락 — 시간 / 시간대 / 깊은 작업 보호), '**Async 형식**' (bullets — 어디에 (Slack / Notion 페이지 / 폼) / 언제까지 작성 / 어떤 양식), '**템플릿 (복붙용)**' (코드 블록 — 각 사람이 매주 채울 양식 — '지난 주 ✓ / 이번 주 → / 막힘 ⚠ / 도움 🆘'), '**Sync는 언제 다시 필요한가요**' (bullets — 분기 1회 / 결정 필요 / 사람 변동), '**Trial 기간 + 측정**' (1줄 — '4주 trial, 그 후 retro로 결정').\n\n기존 미팅 컨텍스트:\n${text}`,
  translate_ko_to_malayalam: (text) =>
    `Translate the Korean text below into natural Malayalam (മലയാളം). 격식 ('നിങ്ങൾ' 정중 / 'നീ' 친근) 원문에 맞춤. Reply with two sections: '**വിവർത്തനം**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_quarterly_strategic_review_ko: (text) =>
    `Build a Korean customer Quarterly Strategic Review (QSR) doc — exec-level deep doc for the most strategic customers. CSM + 영업 lead + Exec sponsor. Use 합쇼체. Markdown: '**한 줄 상태**' (1줄 — 'X 단계, 전략적 우선순위 Y에 정렬'), '**고객 측 미션 / 전략 한 줄**' (1줄 — 그들이 본인 회사에서 추구하는 것), '**우리 가치 (지난 분기)**' (3 bullets — 데이터 + 영향), '**전략 정렬 — 어떻게 우리가 그들의 다음 분기 미션을 돕나**' (1단락), '**투자 제안**' (bullets — 추가 도입 모듈 / 확장 좌석 / 컨설팅), '**위험 / 우려 (솔직)**' (2 bullets), '**Exec ↔ Exec 결정 필요 사항**' (numbered), '**다음 분기 약속 (양쪽)**' (bullets — 우리가 할 것 / 그쪽이 할 것), '**다음 QSR 시점**' (1줄).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_gujarati: (text) =>
    `Translate the Korean text below into natural Gujarati (ગુજરાતી). 격식 ('તમે' 정중 / 'તું' 친근) 원문에 맞춤. Reply with two sections: '**અનુવાદ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  engineering_runbook_template_ko: (text) =>
    `Build a Korean engineering runbook template — used during incidents. Use 해요체 (incident 중에 빠르게 읽기 좋게). 짧고 행동 위주. Markdown: '**상황 한 줄**' (1줄 — '이 runbook은 ~ 알람 / 증상이 났을 때 쓰세요'), '**즉시 확인 (1분 안)**' (numbered — 'X dashboard / Y 로그 / Z status'), '**일반적 원인 + 빠른 fix (테이블)**' ('원인 | 신호 | 빠른 mitigation | 영구 fix 링크'), '**Escalation 기준**' (1줄 — '~분 안 해결 안 되면 누구 ping'), '**Comms 템플릿**' (bullets — '내부 Slack 메시지 1줄 / 외부 status page 1줄 / 고객 메시지 1줄'), '**Postmortem 트리거**' (1줄 — '~ 이상 영향이면 PM 필수'), '**관련 자료**' (bullets — dashboard / 코드 / 관련 PRD).\n\n시스템 / 알람 컨텍스트:\n${text}`,
  translate_ko_to_odia: (text) =>
    `Translate the Korean text below into natural Odia (ଓଡ଼ିଆ). 격식 ('ଆପଣ' 정중 / 'ତୁମେ' 친근) 원문에 맞춤. Reply with two sections: '**ଅନୁବାଦ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  marketing_pr_pitch_email_ko: (text) =>
    `Draft a Korean PR pitch email — cold outbound to a journalist or 매체. Use 해요체. 짧 + 매체 / 기자 맞춤화. 'press release' 페이지 링크만 보내는 형식 X. Markdown: '**제목**' (1줄, 24자 이내 — 기자 / 매체에 맞춘 hook), '**본문**' (3 단락: 1) 1-2줄 — '안녕하세요 [기자명], [매체]의 [지난 기사] 잘 봤습니다. 그 주제와 연결되는 한 가지 제안드려도 될까요', 2) 한 가지 stat / 사실 / 발견 — 왜 지금 / 왜 그쪽 독자에게 흥미로운지 1단락, 3) 짧은 요청 — 15분 통화 또는 'X 데이터 보내드릴까요' + 일정 후보 2개), '**P.S.**' (1줄 — 본인 / 회사 1줄, embargo 가능 여부).\n\n매체 / 발표 컨텍스트:\n${text}`,
  translate_ko_to_assamese: (text) =>
    `Translate the Korean text below into natural Assamese (অসমীয়া). 격식 ('আপুনি' 정중 / 'তুমি' 친근 / 'তই' 매우 친근) 원문에 맞춤. Reply with two sections: '**অনুবাদ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_offboarding_email_ko: (text) =>
    `Draft a Korean customer offboarding email — sent when a customer churns / cancels. Use 해요체. 따뜻 + 솔직 + 문 열어둠 + 데이터. Markdown: '**제목**' (1줄, 26자 이내 — '아쉽지만, [고객사] 계약 종료 안내'), '**본문**' (4 단락: 1) 함께한 시간 감사 + 1줄 — 우리에게 어떤 배움이었는지, 2) 종료 일정 안내 — 마지막 사용일 / 데이터 export 시한 / 결제 환불 (있다면) — 구체적, 3) 떠나는 이유에 대한 짧은 부탁 — '5분이라도 솔직히 알려주시면 우리가 더 잘 만들 수 있어요' — 부담 없이, 4) 문 열어둠 — '나중에 다시 필요하시면 X에게 연락 주세요, 데이터 6개월 보관'), '**P.S.**' (1줄 — 추천 가능한 다른 도구 솔직히, 우리에게 안 맞았다면).\n\n고객 / 종료 컨텍스트:\n${text}`,
  translate_ko_to_nepali: (text) =>
    `Translate the Korean text below into natural Nepali (नेपाली). 격식 ('तपाईं' 정중 / 'तिमी' 친근 / 'तँ' 매우 친근) 원문에 맞춤. Reply with two sections: '**अनुवाद**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  team_retro_continue_stop_start_ko: (text) =>
    `Build a Korean team retro (회고) doc using 'Continue / Stop / Start' format — sprint 또는 분기 단위. Use 해요체. 안전한 공간 강조. Markdown: '**Retro 한 줄**' (스프린트 / 기간 / 참석자 수), '**Health check (1-5)**' (테이블 — '카테고리 | 평균 점수' — 모르겠지만 보통: 협업 / 명확성 / 속도 / 즐거움 / 임팩트), '**Continue (계속할 것)**' (bullets — 익명 인풋 + 그룹 정리, 각 1줄 + 사례), '**Stop (멈출 것)**' (bullets — 같은 형식), '**Start (시작할 것)**' (bullets — 같은 형식 + 누가 시도할지 1줄), '**투표로 결정한 Top 3 액션 (테이블)**' ('액션 | 담당 | 시한 | 어떻게 측정'), '**다음 retro에서 확인할 것**' (1줄), '**Facilitator 노트**' (1줄 — 다음 facilitator).\n\n팀 / 스프린트 컨텍스트:\n${text}`,
  translate_ko_to_kashmiri: (text) =>
    `Translate the Korean text below into natural Kashmiri (कॉशुर / کٲشُر). Devanagari 또는 Perso-Arabic script — 입력 컨텍스트로 추론, default Perso-Arabic. 격식 ('تۆہِہ' 정중 / 'ژہ' 친근) 원문에 맞춤. Reply with two sections: '**ترجمہٕ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  engineering_arch_review_doc_ko: (text) =>
    `Build a Korean engineering architecture review doc — for any project that introduces a new service / new data store / major migration. Use 합쇼체. Reviewed by Eng Lead + Staff Eng. Markdown: '**한 줄 (Tagline)**' (1줄 — 무엇을 / 왜), '**문제 정의**' (1단락 — 비즈니스 + 기술), '**제안 아키텍처 (1단락 + 다이어그램 placeholder)**' (서비스 / 데이터 / 흐름), '**고려한 대안 (3가지)**' (각 'h3 + Pros + Cons + 왜 안 골랐는지'), '**선택 이유**' (1단락), '**Non-functional 요구**' (테이블 — 'SLO | 처리량 | 데이터 무결성 | 보안 | 비용'), '**위험 (Top 5)**' (테이블 — '위험 | 가능성 | 영향 | 완화 액션'), '**롤아웃 plan**' (numbered — 단계별 + flag), '**Open questions (review에서 답 받을 것)**' (bullets), '**리뷰어 / 일정**' (1줄).\n\n프로젝트 컨텍스트:\n${text}`,
  translate_ko_to_dari: (text) =>
    `Translate the Korean text below into natural Dari (Afghan Persian — دری). RTL 흐름. 격식 ('شما' 정중 / 'تو' 친근) 원문에 맞춤. 표현은 Afghan Dari 사용 (Iranian Persian과 약간 다름). Reply with two sections: '**ترجمه**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_negotiation_email_ko: (text) =>
    `Draft a Korean customer renewal negotiation email — sent when a customer has pushed back on price for renewal. Use 해요체. 진심 + 데이터 + 작은 양보. Markdown: '**제목**' (1줄, 28자 이내 — '[고객사] 갱신 — 다음 단계 제안'), '**본문**' (4 단락: 1) 1줄 — 그쪽 우려 인정 + 가치 1줄 재확인, 2) 우리가 본 그쪽의 사용 / 가치 — 구체 데이터 + 1-2개 가장 큰 성과 (data로 reframe), 3) 3가지 옵션 제안 — A: 현재 가격 + X 추가 가치 / B: 약간 가격 양보 + Y 약속 / C: 다년 계약 + Z%, 4) 결정 마감일 + 누가 결정하는지 + 우리가 도울 것), '**P.S.**' (1줄 — '편하게 30분 통화로도 가능, 시간 후보 X').\n\n계약 / 협상 컨텍스트:\n${text}`,
  translate_ko_to_swiss_german: (text) =>
    `Translate the Korean text below into natural Swiss German (Schweizerdeutsch). 격식 ('Sie' 정중 / 'du' 친근) 원문에 맞춤. Standard Hochdeutsch 아닌 실제 Swiss German 표현 / 어휘 사용. Reply with two sections: '**Übersetzig**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  sales_cold_call_script_ko: (text) =>
    `Draft a Korean sales cold call script — 60초 안에 끝낼 수 있어야 함. Use 해요체. 자연스러운 대화, 'sales pitch' 톤 피하기. Markdown: '**Opening (10초)**' (1줄 — 본인 + 회사 + 1줄 — '~ 때문에 전화드렸어요'), '**Permission (5초)**' (1줄 — '2분만 시간 괜찮으세요?' — 거절 받을 준비), '**Pain hook (20초)**' (2-3줄 — 비슷한 회사가 겪는 1가지 페인 + 우리가 들은 이유), '**Curiosity question (15초)**' (1-2줄 — open question — '그쪽도 비슷한 경험 있으세요?'), '**Next step (10초)**' (1줄 — 15분 데모 미팅 제안 + 일정 후보 2개 — soft close), '**거절 처리 (3가지)**' (테이블 — '거절 종류 | 우리 응답 1줄'), '**음성메일 남기는 경우 (15초)**' (1단락 — 다시 걸기 시점 약속).\n\n타겟 / 우리 제품 컨텍스트:\n${text}`,
  translate_ko_to_pidgin_english: (text) =>
    `Translate the Korean text below into natural Nigerian Pidgin English (Naija). 격식은 거의 없음, 친근 / 직설 톤이 표준. Reply with two sections: '**Pidgin**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  culture_doc_principles_ko: (text) =>
    `Draft a Korean company culture doc — '우리는 어떤 회사인가' 한 페이지 문서, 외부 공개용 또는 신입 1주차 읽는 자료. Use 해요체. 빈말 / 'family' 같은 표현 금지. 실제 의사결정 / 행동에 영향을 주는 5-6개 신념. Markdown: '**우리 회사 1줄 (미션 또는 정체성)**' (1줄), '**우리가 진심으로 믿는 것 (5-6개 — 각 h3 + 1줄 + 우리가 실제로 한 행동 1개 + 우리가 안 하는 행동 1개)**', '**여기서 일하는 게 좋은 사람**' (3 bullets — 구체적 — 빈말 X), '**여기서 일하는 게 안 좋을 수 있는 사람**' (2-3 bullets — 솔직 — fit), '**우리가 항상 이렇게 살까요? (1단락)**' (솔직 — 'no, 이런 때 우리도 깨졌다 + 우리가 어떻게 복원했나').\n\n회사 컨텍스트 / 신념:\n${text}`,
  translate_ko_to_papiamento: (text) =>
    `Translate the Korean text below into natural Papiamento (spoken in Aruba, Curaçao, Bonaire). 격식 ('bo' 친근 표준 / 더 정중하게는 회사명 / 호칭 사용) 원문에 맞춤. Reply with two sections: '**Tradukshon**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_check_in_30_day_email_ko: (text) =>
    `Draft a Korean customer 30-day check-in email — sent by CSM to a new customer at D+30. Use 해요체. 따뜻 + 데이터 + 행동 제안. Markdown: '**제목**' (1줄, 24자 이내 — '한 달 어떠세요? 30일 후 안부'), '**본문**' (4 단락: 1) 1줄 — 30일 함께해 줘서 감사 + 본인 안부, 2) 우리가 본 그쪽 사용 — 구체 데이터 — '로그인 N회 / 핵심 기능 X 사용 / 팀원 Y명 참여', 3) 비슷한 단계 고객이 보통 이 시기에 하는 것 — '대부분 다음 30일에 Z를 시도해요' — 부담 없이 1-2개 제안, 4) 짧은 부탁 — '5분 통화 가능? 잘 된 / 막힌 것 듣고 싶어요' + 일정 후보 2개), '**P.S.**' (1줄 — 도움 문서 / 슬랙 채널 placeholder).\n\n고객 / 사용 데이터:\n${text}`,
  translate_ko_to_swiss_french: (text) =>
    `Translate the Korean text below into natural Swiss French (français de Suisse). 격식 ('vous' 정중 / 'tu' 친근) 원문에 맞춤. Use Swiss numerals (septante / huitante / nonante 가능). Reply with two sections: '**Traduction**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_executive_qbr_pre_brief_ko: (text) =>
    `Build a Korean exec-level pre-brief for a customer QBR — sent to our Exec sponsor 24 hours before the meeting so they can show up sharp. Use 합쇼체. 1 페이지 max. Markdown: '**미팅 한 줄**' (1줄 — '내일 [고객사] QBR, 우리 목적 1줄'), '**고객 핵심 인물 (3명)**' (각 'h3: 이름 + 직책 + 우리에 대한 sentiment + 우리가 알아야 할 1줄'), '**최근 90일 우리 가치 (3 bullets)**' (메트릭 + 1줄), '**우리가 받을 가능성 높은 질문 + 추천 답변 (3쌍)**' ('Q: ... / A: 1줄'), '**우리가 묻고 싶은 1가지**' (1줄 — 가장 중요한 정보), '**위험 신호 / 우리가 피해야 할 주제**' (2 bullets — 사전 경고), '**미팅에서 commit 가능한 1가지 (Exec 결재 ready)**' (1줄).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_quebec_french: (text) =>
    `Translate the Korean text below into natural Quebec French (français québécois). 격식 ('vous' 정중 / 'tu' 친근) 원문에 맞춤. Use Quebec expressions and vocabulary where natural (e.g., 'courriel' for email, 'magasiner' for shopping). Reply with two sections: '**Traduction**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  brand_naming_brainstorm_ko: (text) =>
    `Build a Korean brand / product naming brainstorm doc — for a new product / company. Use 해요체. Markdown: '**명명 대상 한 줄**' (1줄 — 무엇 / 누구를 위해 / 어떤 느낌), '**기준 (3-5개)**' (bullets — 도메인 가능 / 1-3 음절 / 발음 쉬움 / 영문 명사 X 등), '**1차 후보 (15-25개, 분류별)**' (테이블 — '이름 | 분류 (단어 / 합성 / 신조어 / 인물) | 의미 1줄 | 느낌 | 도메인 추정'), '**상위 5개 (각 1단락 분석)**' ('h3: 이름 — 왜 좋은가 / 약점 / 도메인 / 상표 위험 / 다른 언어에서 부정적 의미 체크'), '**탈락 후보 + 이유**' (bullets), '**다음 단계**' (1줄 — '5개로 사용자 X명에게 reaction test').\n\n제품 / 브랜드 컨텍스트:\n${text}`,
  translate_ko_to_brazilian_portuguese: (text) =>
    `Translate the Korean text below into natural Brazilian Portuguese (português brasileiro). 격식 ('você' 표준 — 정중 / 'tu' 일부 지역) 원문에 맞춤. Use Brazilian vocabulary (e.g., 'ônibus' for bus, 'celular' for cellphone). Reply with two sections: '**Tradução**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_announcement_promotion_ko: (text) =>
    `Draft a Korean internal announcement of an employee promotion — sent by manager to the team. Use 해요체. 진심 + 구체적 + 잘난 척 없게. Markdown: '**제목**' (1줄, 26자 이내 — '[이름] 승진 안내 — [새 직책]'), '**본문**' (3 단락: 1) 1줄 — 오늘부로 [이름]이 [새 직책]으로 승진, 2) 왜 — 지난 X개월 동안 본 구체적 임팩트 3가지 + 동료 / 고객이 본 그녀의 강점 1줄, 3) 다음 — 새 역할에서 무엇을 책임지나 + 팀이 어떻게 그녀를 지원할 수 있나), '**축하 한 줄**' (1줄 — 본인에게 직접 슬랙 가능), '**Q&A**' (1줄 — '궁금한 점은 [매니저]에게 DM').\n\n승진 / 컨텍스트:\n${text}`,
  translate_ko_to_mexican_spanish: (text) =>
    `Translate the Korean text below into natural Mexican Spanish (español mexicano). 격식 ('usted' 정중 / 'tú' 친근) 원문에 맞춤. Use Mexican vocabulary and expressions where natural (e.g., 'mucho' modifiers, 'andale' style). Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_complaint_response_ko: (text) =>
    `Draft a Korean response to a customer complaint — escalated case, sent by support lead or CSM. Use 해요체. 인정 + 책임 + 액션 + 사람 냄새. 'we apologize for inconvenience' 같은 형식 답변 금지. Markdown: '**제목**' (1줄, 24자 이내 — '[티켓번호] 답변 — [한 줄 요약]'), '**본문**' (4 단락: 1) 1-2줄 — 그쪽 frustration 인정 + 우리 잘못 인정 (책임 회피 X), 2) 무엇이 일어났는지 — 우리 측 정보 정확히, 회피 X, 3) 우리가 한 / 할 것 — 즉시 액션 + 장기 액션 — 구체적 + 시한, 4) 보상 (가능하면) + 다시는 같은 문제 안 일어나게 무엇이 달라질지), '**서명**' (이름 + 직책 — 본인 책임이라는 신호).\n\n불만 / 컨텍스트:\n${text}`,
  translate_ko_to_argentinian_spanish: (text) =>
    `Translate the Korean text below into natural Argentinian Spanish (español rioplatense). 격식 ('usted' 정중 / 'vos' 친근 — Argentinian voseo) 원문에 맞춤. Use 'vos' conjugations where natural (e.g., 'tenés', 'querés'). Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  team_okr_check_in_doc_ko: (text) =>
    `Build a Korean monthly team OKR check-in doc — used in a 30-min team meeting mid-quarter. Use 해요체. 빠른 확인 + 솔직. Markdown: '**한 줄 (이번 달)**' (1줄 — 'on track / at risk / off track + 1줄 근거'), '**KR별 (테이블)**' ('KR | 목표 | 현재 | 진행률 % | 신호등 | 가장 큰 위험'), '**at risk / off track KR — 깊은 분석**' (각 'h3 + 왜 (구체적) + 회복할지 / 다시 baseline 다시 잡을지 + 누구 도움'), '**잘 가고 있는 것 — 가속화 기회**' (bullets), '**자원 부족 / 막힘**' (bullets — 매니저 / 다른 팀에 부탁), '**다음 30일 commit (3가지)**' (numbered).\n\nOKR 상태 / 데이터:\n${text}`,
  translate_ko_to_castilian_spanish: (text) =>
    `Translate the Korean text below into natural Castilian Spanish (español de España). 격식 ('usted' 정중 / 'tú' / 'vosotros' 복수 친근) 원문에 맞춤. Use Spain-specific vocabulary (e.g., 'coger' instead of 'tomar', 'ordenador' instead of 'computadora'). Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_at_risk_email_ko: (text) =>
    `Draft a Korean at-risk customer renewal email — sent when a customer has shown churn signals (다 안 쓰는 / 챔피언 이직 / 가격 불만). Use 해요체. 진심 + 데이터 + 다음 단계. Markdown: '**제목**' (1줄, 24자 이내 — '[고객사] 우리 협력 — 잠깐 시간 되세요?'), '**본문**' (4 단락: 1) 1줄 — 본인 안부 + 우리가 본 신호 1줄 (직설적), 2) 우리가 잘못한 것 / 놓친 것 인정 — 구체적, 회피 X, 3) 우리가 들으면 좋겠는 것 + 30분 통화 요청 — 가벼운 톤, 4) 만약 떠나기로 했다면 — 어떻게든 우리가 도울 수 있는 것 (데이터 export / 추천 / 우리 학습)), '**P.S.**' (1줄 — Exec sponsor에게도 같이 cc 가능).\n\n고객 / 신호 컨텍스트:\n${text}`,
  translate_ko_to_european_portuguese: (text) =>
    `Translate the Korean text below into natural European Portuguese (português europeu). 격식 ('você' / 'o senhor / a senhora' 정중 / 'tu' 친근) 원문에 맞춤. Use European Portuguese vocabulary (e.g., 'autocarro' for bus, 'pequeno-almoço' for breakfast). Reply with two sections: '**Tradução**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  legal_template_nda_short_ko: (text) =>
    `Draft a Korean short NDA (Non-Disclosure Agreement) template — 1 페이지 max, 양자 (mutual) 표준. Use 합쇼체. 법적 효력 있는 표현 사용하되 쉽게. Markdown: '**제목**' (1줄 — 'Mutual Non-Disclosure Agreement (NDA) — 비밀유지계약서'), '**당사자 (Parties)**' (bullets — '갑: [회사명], 주소, 대표' + '을: [회사명/개인명], 주소, 대표'), '**목적 (Purpose)**' (1단락 — 무엇을 위한 정보 교환), '**기밀 정보 정의**' (1단락), '**의무 (Obligations)**' (3-4 bullets — 사용 제한 / 공개 제한 / 보관 / 직원 통제), '**예외 (Exclusions)**' (bullets — 이미 공개 / 자체 개발 / 법적 강제), '**기간 + 종료**' (1단락 — '본 계약은 X년, 종료 후 Y년 추가 의무'), '**위반 시**' (1단락), '**준거법 / 관할**' (1줄 — '대한민국 법, [법원] 관할'), '**서명란**' (테이블 — '날짜 / 회사명 / 이름 / 서명').\n\nNDA 컨텍스트:\n${text}`,
  translate_ko_to_european_french: (text) =>
    `Translate the Korean text below into natural European French (français de France). 격식 ('vous' 정중 / 'tu' 친근) 원문에 맞춤. Use Metropolitan French vocabulary and expressions. Reply with two sections: '**Traduction**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  partnerships_intro_summary_ko: (text) =>
    `Build a Korean partnership intro summary doc — sent to a potential partner before the first call to align expectations. Use 해요체. 1 페이지. Markdown: '**우리 한 줄**' (회사 / 단계 / ICP / 우리가 가장 잘하는 1가지), '**그쪽 한 줄 (우리가 본대로)**' (1단락 — 그쪽 회사 + 우리가 추측하는 그쪽 우선순위), '**우리가 함께 할 수 있는 3가지 (가설)**' (각 'h3 + 1단락 — 무엇 / 누구에게 / 어떤 가치'), '**첫 미팅 어젠다 (제안)**' (numbered — '소개 5분 / 그쪽 우선순위 10분 / 우리 우선순위 5분 / 옵션 토론 10분 / 다음 단계 5분'), '**우리가 답하고 싶은 그쪽 질문**' (bullets), '**우리가 묻고 싶은 그쪽 질문**' (bullets), '**그 다음 단계 (제안)**' (1줄).\n\n파트너 / 우리 컨텍스트:\n${text}`,
  translate_ko_to_european_german: (text) =>
    `Translate the Korean text below into natural European German (Hochdeutsch — Germany standard). 격식 ('Sie' 정중 / 'du' 친근) 원문에 맞춤. Reply with two sections: '**Übersetzung**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_invoice_overdue_email_ko: (text) =>
    `Draft a Korean customer invoice overdue email — Net-30 기준 7일 지났을 때 첫 reminder. Use 해요체. 친근 + 명확 + 부담 없게 (관계 보호). Markdown: '**제목**' (1줄, 26자 이내 — '[송장번호] 결제 안내 — 작은 reminder'), '**본문**' (3 단락: 1) 1줄 — 짧은 안부 + 친근 톤 — '바쁘신 와중에 작은 알림', 2) 송장 정보 — 번호 / 금액 / 원래 만기일 / 며칠 지났는지 / 결제 방법 링크 — 명확히, 3) 부담 없게 — '이미 결제하셨다면 이 메일은 무시해주세요' + '혹시 우리 쪽 누락이거나 문제가 있으면 답장 / [연락처]'), '**P.S.**' (1줄 — 다음 reminder는 X일에 보낼 예정 안내).\n\n송장 / 고객 컨텍스트:\n${text}`,
  translate_ko_to_austrian_german: (text) =>
    `Translate the Korean text below into natural Austrian German (österreichisches Deutsch). 격식 ('Sie' 정중 / 'du' 친근) 원문에 맞춤. Use Austrian vocabulary where natural (e.g., 'Jänner' for January, 'Erdäpfel' for potatoes, 'Sackerl' for bag). Reply with two sections: '**Übersetzung**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  weekly_team_health_pulse_ko: (text) =>
    `Build a Korean weekly team health pulse — short async form sent every Friday to team members. Use 해요체. 익명 옵션 강조. Markdown: '**제목 (이메일 / 폼)**' (1줄 — '주간 health pulse — 30초만'), '**왜 보내요 (1줄)**' (1줄 — '매니저가 빨리 도울 수 있게'), '**질문 (5개, 각 1-5 척도)**' (numbered: 1) 이번 주 명확성 (내가 해야 할 게 명확했나) 1-5, 2) 협업 (도움 요청에 응답 받았나) 1-5, 3) 진척 (의미 있는 진전을 느꼈나) 1-5, 4) 에너지 (이번 주 끝에 에너지가 남았나) 1-5, 5) 답하고 싶은 1가지 (open)), '**보내는 방법**' (1줄 — 'Slack 폼 / Google Form 익명 / Notion'), '**매니저가 어떻게 쓰나요 (1단락)**' (3-4줄 — 보이는 패턴에 대응 / 개인 1:1 시 사용 / 절대 평가에 안 씀).\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_andean_spanish: (text) =>
    `Translate the Korean text below into natural Andean Spanish (español andino — Bolivia / Peru / Ecuador 산악 지역). 격식 ('usted' 정중 / 'tú' 친근) 원문에 맞춤. Quechua / Aymara 영향 어휘 자연스럽게 사용 가능. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_qr_code_handout_ko: (text) =>
    `Build a Korean customer-facing QR code handout — printable 1 페이지 for events / trade shows. Use 해요체. 짧 + 행동 위주. Markdown: '**메인 메시지 (큰 글씨)**' (1줄, 12자 이내 — 'QR을 찍으세요 — [핵심 가치]'), '**서브 메시지 (1줄)**' (1줄 — 무엇이 일어날지), '**3가지 베네핏 (bullets)**' (각 1줄 — 시간 / 비용 / 결과), '**QR 코드 + landing URL (placeholder)**' (1줄), '**CTA**' (1줄 — 'X분 안 / 무료 / 회원가입 불요'), '**소속 표시**' (1줄 — 회사 / 부스 번호 / 담당).\n\n이벤트 / 제품 컨텍스트:\n${text}`,
  translate_ko_to_caribbean_spanish: (text) =>
    `Translate the Korean text below into natural Caribbean Spanish (español caribeño — Cuba / DR / PR / Venezuela coast). 격식 ('usted' 정중 / 'tú' 친근) 원문에 맞춤. 빠른 / 친근한 톤이 표준, 'h' / 's' 발음 약함 (글에는 표시 X). Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  exec_team_huddle_agenda_ko: (text) =>
    `Build a Korean exec team huddle (weekly 30-min stand-up) agenda. Use 합쇼체. 짧 + 결정 위주, 단순 업데이트는 사전 share. Markdown: '**Huddle 한 줄**' (1줄 — '이번 주 핵심 결정 / 우려 1줄'), '**Pre-read (이미 share 된 것)**' (bullets — Slack 링크 placeholder), '**Agenda (30분 — 테이블)**' ('시간 | 항목 | 진행자 | 결정 또는 토론'), '**결정 필요 사항 (3개 max — numbered)**' (각 '결정 1줄 / 옵션 1-2 / 우리 추천'), '**위험 / 안 좋은 신호 (Top 3)**' (bullets — 누가 / 무엇 / 우리 대응), '**좋은 신호 (Top 2)**' (bullets), '**Skip / 다음 주로 미루는 것**' (bullets), '**Owner / 시한**' (테이블 — 'huddle 후 액션 | 담당 | 시한').\n\n이번 주 컨텍스트:\n${text}`,
  translate_ko_to_chilean_spanish: (text) =>
    `Translate the Korean text below into natural Chilean Spanish (español chileno). 격식 ('usted' 정중 / 'tú' 친근) 원문에 맞춤. Chilean expressions 자연스럽게 ('po' 어말 / 'cachai' 친근). Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_loyalty_offer_email_ko: (text) =>
    `Draft a Korean customer loyalty offer email — sent to long-time customers (보통 12+ months) with a thank-you + exclusive offer. Use 해요체. 진심 + 명확한 가치. Markdown: '**제목**' (1줄, 26자 이내 — '[고객명]님, 1년 함께해 주셔서 감사해요'), '**본문**' (4 단락: 1) 1-2줄 — 함께한 X개월 감사 + 본인이 직접 본 한 가지 그쪽 성장, 2) 진심 1단락 — 왜 그쪽 같은 분이 우리에게 중요한지, 3) Exclusive offer 명확히 — 무엇 / 얼마 / 언제까지 / 어떻게 (긴급한 톤 X, 'X일 안에' 같은 fake 시간 X), 4) 짧은 부탁 — '5분 통화로 어떻게 더 잘 도울 수 있을지 듣고 싶어요' — 옵션), '**P.S.**' (1줄 — 추천하면 양쪽에 추가 보상 안내).\n\n고객 / 관계 컨텍스트:\n${text}`,
  translate_ko_to_peruvian_spanish: (text) =>
    `Translate the Korean text below into natural Peruvian Spanish (español peruano). 격식 ('usted' 정중 / 'tú' 친근) 원문에 맞춤. Lima 표준 또는 Quechua 영향 표현 가능. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_skip_level_invite_ko: (text) =>
    `Draft a Korean skip-level 1:1 meeting invite — sent by skip-level manager (매니저의 매니저) to an IC. Use 해요체. 따뜻 + 안전 + 명확. 'evaluation' 톤 절대 X. Markdown: '**제목**' (1줄, 22자 이내 — '[이름]님, 30분 커피챗 어떠세요?'), '**본문**' (3 단락: 1) 1-2줄 — 본인 소개 (이미 알 수도) + 정기적으로 우리 팀 모두와 1:1 하는 이유 — 듣는 것이 목적, 2) 우리가 다룰 수 있는 것 — 본인 일 / 잘 되는 것 / 막힘 / 매니저에게 말하기 어려운 것 — 자유롭게, 평가가 아님 강조, 3) 일정 후보 3개 + 시간대 / 방식 (커피 / 산책 / Zoom)), '**P.S.**' (1줄 — 'Topic 미리 안 주셔도 OK, 아무 부담 없이 와주세요').\n\n관계 / 컨텍스트:\n${text}`,
  translate_ko_to_colombian_spanish: (text) =>
    `Translate the Korean text below into natural Colombian Spanish (español colombiano). 격식 ('usted' 정중 — Colombian 정중 표준 사용 빈도 높음 / 'tú' 친근) 원문에 맞춤. Paisa / Bogotano expressions 자연스럽게. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_quarterly_winback_email_ko: (text) =>
    `Draft a Korean quarterly customer winback email — sent to customers who churned 3+ months ago. Use 해요체. 자존심 / sales 톤 X, 호기심 + 가치. Markdown: '**제목**' (1줄, 26자 이내 — '오랜만이에요 — [회사명] 잠깐 안부'), '**본문**' (3 단락: 1) 1-2줄 — 떠난 지 X개월 + 마지막으로 봤을 때 함께한 성과 1줄 — 진심으로, 2) 그동안 우리가 한 1-2가지 — 그쪽이 떠난 이유와 관련 있는 변화 — '그때 ~ 때문에 떠나셨던 것 기억해요. 그 부분 X 이렇게 달라졌어요', 3) 부담 없는 다음 단계 — '20분 통화로 다시 한 번 보실 가치 있는지 같이 판단 / 새 시도 가능' — 강제 X), '**P.S.**' (1줄 — '만약 다른 도구로 잘 해결되셨다면 정말 다행이에요, 우리 계속 응원해요').\n\n고객 / 떠난 이유 컨텍스트:\n${text}`,
  translate_ko_to_uruguayan_spanish: (text) =>
    `Translate the Korean text below into natural Uruguayan Spanish (español uruguayo). 격식 ('usted' 정중 / 'vos' 친근 — Argentinian과 유사 voseo) 원문에 맞춤. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_executive_intro_email_ko: (text) =>
    `Draft a Korean exec-to-exec intro email — our CEO / VP reaching out to customer's CEO / VP for the first time. Use 합쇼체. 짧 + 존중 + 명확한 요청. Markdown: '**제목**' (1줄, 28자 이내 — '[우리 회사] [직책] 인사 — 짧은 노트'), '**본문**' (3 단락: 1) 1-2줄 — 본인 + 우리 회사 + 왜 직접 연락 — 'CSM이 알려준 그쪽 분기 성장 정말 인상적이었습니다', 2) 한 가지 가치 / 통찰 — 우리가 그쪽 산업 / 비슷한 고객에게서 본 한 가지 trend + 그쪽과 어떻게 연결되는지 — 자랑 X, 3) 짧은 요청 — '20분 통화 가능하시면 / 또는 quarterly QSR에 직접 참여하고 싶습니다' + 일정 후보 2-3개), '**서명**' (이름 + 직책 + 우리 회사 + 직접 휴대전화).\n\n관계 / 컨텍스트:\n${text}`,
  translate_ko_to_paraguayan_spanish: (text) =>
    `Translate the Korean text below into natural Paraguayan Spanish (español paraguayo). 격식 ('usted' 정중 / 'vos' 친근 voseo) 원문에 맞춤. Guaraní 영향 또는 'jopara' 혼용 표현 자연스럽게 사용 가능. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  competitive_displacement_playbook_ko: (text) =>
    `Build a Korean competitive displacement playbook — used by sales when pitching against a specific incumbent vendor. Use 합쇼체. Markdown: '**상대 한 줄**' (1줄 — incumbent 이름 + 우리가 displace 하려는 고객 segment), '**상대의 강점 (객관적)**' (3 bullets), '**상대의 약점 (우리가 이기는 지점) — 데이터 + 인용**' (3 bullets — 각 '신호 + 비슷한 고객 인용 1줄'), '**Displacement signals — 우리가 노릴 트리거**' (bullets — 가격 인상 / 계약 만료 / 챔피언 이직 / 신규 모듈 X 안 됨 등), '**Discovery 질문 5가지**' (numbered — 페인을 노출시키는 open 질문), '**Migration 우려에 대한 답변**' (테이블 — '우려 | 우리 답변 1줄 + 보조 자료'), '**가격 / 인센티브 옵션**' (bullets — 'A: X% 할인 / B: 무료 migration / C: Y개월 무료 병행 사용'), '**Reference customer (이전 displaced 사례)**' (1단락 — 이름 / 결과 / 인용).\n\n상대 / 우리 컨텍스트:\n${text}`,
  translate_ko_to_venezuelan_spanish: (text) =>
    `Translate the Korean text below into natural Venezuelan Spanish (español venezolano). 격식 ('usted' 정중 / 'tú' 친근) 원문에 맞춤. Caracas / Maracaibo expressions 자연스럽게. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_offsite_planning_doc_ko: (text) =>
    `Build a Korean internal team offsite planning doc — used to plan a 2-3 day team retreat (이벤트 / 작업 / 휴식 균형). Use 해요체. Markdown: '**Offsite 한 줄**' (1줄 — 시기 / 장소 / 핵심 목적 1개), '**참석자**' (bullets — 이름 + 직책), '**예산**' (1줄 — 총액 + 1인당), '**일정 (테이블)**' ('일자 | 시간 | 활동 | 진행 | 비용 | 비고'), '**식사 / 식이 제한**' (bullets — 알레르기 / 비건 / 종교), '**숙소 정보**' (bullets — 주소 / 체크인 / 룸 배정), '**교통**' (bullets — 항공 / 픽업 / 지역 이동), '**준비물**' (bullets — 본인 / 회사 제공), '**Off-the-record 시간**' (bullets — 자유 시간 / 휴식 명시), '**Comms plan**' (bullets — Slack 채널 / 위기 시 연락처), '**Offsite 후 follow-up**' (bullets — survey / 액션 정리 시한).\n\nOffsite 컨텍스트:\n${text}`,
  translate_ko_to_dominican_spanish: (text) =>
    `Translate the Korean text below into natural Dominican Spanish (español dominicano). 격식 ('usted' 정중 / 'tú' 친근) 원문에 맞춤. Caribbean Spanish 패턴 + Dominican expressions ('qué lo qué' 친근 인사). Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_seat_expansion_email_ko: (text) =>
    `Draft a Korean customer seat expansion email — sent by CSM when usage signals show the customer needs more seats / users. Use 해요체. 친근 + 데이터 + 부담 없음. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] 좌석 확장 — 작은 제안'), '**본문**' (4 단락: 1) 1-2줄 — 안부 + 좋은 신호 1줄 — '팀이 정말 활발히 쓰시는 것 보고 있어요', 2) 우리가 본 사용 데이터 — '현재 X 좌석 중 Y명 활발 / 새 Z명이 게스트로 가입 시도'  — 구체적, 3) 제안 — N개 좌석 추가 옵션 — 가격 / 시점 / 변경 절차 — 간단히 + 'X개월 grandfather 가격', 4) 부담 없게 — '아직 결정 시점 아니면 다음 분기 QBR에서 같이 봐도 됨'), '**P.S.**' (1줄 — '바로 결정 도와드릴 30분 통화 일정 후보 2개').\n\n고객 / 사용 데이터:\n${text}`,
  translate_ko_to_panamanian_spanish: (text) =>
    `Translate the Korean text below into natural Panamanian Spanish (español panameño). 격식 ('usted' 정중 / 'tú' 친근) 원문에 맞춤. Caribbean + Central American mixed expressions. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  engineering_postmortem_template_ko: (text) =>
    `Build a Korean engineering postmortem template — neutral form, filled out after a customer-impacting incident. Use 합쇼체. Markdown: '**Incident ID + 한 줄**' (1줄), '**날짜 / 시간 (탐지 → 복구)**' (1줄), '**Severity**' (1줄 — SEV-1/2/3 + 정의), '**Impact (1단락)**' (사용자 수 / 손실 트랜잭션 / 다운타임 / 매출), '**타임라인 (테이블)**' ('시간 | 이벤트 | 행위자(역할)'), '**탐지 (어떻게 알게 됐나)**' (1단락 — 모니터링 / 사용자 ticket / 우연), '**Root cause (기술적)**' (1단락 + 코드 또는 config 인용 placeholder), '**Contributing factors (기술 외)**' (bullets — 프로세스 / 사람 / 도구), '**우리가 잘한 것**' (bullets — 빠른 감지 / 좋은 의사결정), '**우리가 잘못 / 못한 것**' (bullets — 시스템 / 사람 — blameless 톤), '**Action items (테이블)**' ('액션 | 영원성(영구/임시) | 담당 | 시한 | 검증 방법'), '**얻은 교훈 (Lessons)**' (3 bullets).\n\n사건 노트:\n${text}`,
  translate_ko_to_canadian_english: (text) =>
    `Translate the Korean text below into natural Canadian English. 격식 ('you' 표준) 원문에 맞춤. Use Canadian conventions where natural ('colour', 'cheque', 'toque', 'eh' in casual contexts). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_segment_definition_doc_ko: (text) =>
    `Build a Korean customer segment definition doc — used by GTM / Product / 마케팅 to align on who we sell to. Use 합쇼체. Markdown: '**한 줄**' (1줄 — '우리는 [N]개 세그먼트로 시장을 본다'), '**세그먼트 (각 — h2)**', '**세그먼트별 (h2 아래):**' '**한 줄 정의**' (1줄), '**규모 (예상 시장 크기)**' (1줄), '**구체적 firmographic**' (bullets — 회사 크기 / 산업 / 지역 / 기술 스택), '**구체적 behavioral**' (bullets — 페인 / 트리거 / 결정자), '**대표 고객 3개 (사례)**' (bullets — 회사 + 1줄), '**우리에게 왜 좋은가**' (1줄 — ACV / churn / NPS / referral), '**경쟁 환경**' (1줄 — 누구와 경쟁), '**우리 메시지 / value prop (1단락)**', '**우리가 안 노리는 (anti-target)**' (bullets — 명확히 '이런 곳은 안 팔아요'), '**세그먼트 비중 (테이블)**' ('세그먼트 | 현재 ACV % | 미래 % 목표 | 우선순위').\n\n세그먼트 데이터:\n${text}`,
  translate_ko_to_australian_english: (text) =>
    `Translate the Korean text below into natural Australian English. 격식 ('you' 표준 — 친근 톤이 표준) 원문에 맞춤. Use Aussie conventions where natural ('arvo', 'g'day' in casual, 'mate', 'no worries'). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_all_hands_qna_doc_ko: (text) =>
    `Build a Korean internal all-hands Q&A doc — questions submitted async ahead of all-hands, answered by exec team. Use 합쇼체. 솔직 + 회피 없이. Markdown: '**한 줄 (이번 all-hands 주제)**' (1줄), '**질문 받은 방법**' (1줄 — '익명 폼 + Slack thread / 마감 시간'), '**Top 답변 — 직접 답변되는 질문 (테이블)**' ('질문 | 답변 1단락 | 답변자'), '**미응답 / 부분 응답 — 이유 명시**' (bullets — '법적 / 인사 사유로 X 까지 답변 어려움'), '**자주 나온 테마 (개별 답변 대신 그룹화)**' (h3 + 1단락 답변 each — 채용 / 정리해고 / 가격 / 리오그 / 전략 변경), '**다음 all-hands에서 추가로 다룰 것**' (bullets), '**추후 답변 시한 약속**' (1줄 — '미답변 질문 X 까지 follow-up').\n\n질문 모음 / 컨텍스트:\n${text}`,
  translate_ko_to_british_english: (text) =>
    `Translate the Korean text below into natural British English (UK English). 격식 ('you' 표준) 원문에 맞춤. Use British conventions ('colour', 'organisation', 'cheque', 'queue', 'biscuit'). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_journey_email_series_ko: (text) =>
    `Build a Korean customer journey email series (보통 5-7개 메일, 사용자 가입 → activation → habit). Use 해요체. 짧 + 다음 행동 명확. Markdown: '**한 줄 (목표)**' (1줄 — 'X 일 안에 사용자가 Y 액션 N번 하기'), '**시리즈 개요 (테이블)**' ('Day | 트리거 | 제목 | 본문 한 줄 | 다음 액션 (CTA)'), '**Day 0 (가입 직후)**' (제목 + 본문 1단락), '**Day 1 (다음 액션 안내)**', '**Day 3 (가치 알림)**', '**Day 7 (사회적 증거 + 격려)**', '**Day 14 (활성화 안 했으면 — 도움 제안)**', '**Day 21 (활성화 됐으면 — 다음 레벨)**', '**측정**' (bullets — 각 메일 open / click / 이후 전환).\n\n제품 / 사용자 컨텍스트:\n${text}`,
  translate_ko_to_indian_english: (text) =>
    `Translate the Korean text below into natural Indian English. 격식 ('you' / 'Sir' / 'Madam' 정중 표준 자주 사용) 원문에 맞춤. Indian English conventions ('prepone', 'do the needful', 'kindly' frequent). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  saas_metrics_glossary_ko: (text) =>
    `Build a Korean SaaS metrics glossary — used for company-wide alignment on definitions. Use 합쇼체. Markdown: '**한 줄 (왜 만들었나)**' (1줄), '**메트릭별 (각 h3)**', '각 메트릭:' '**정의 (1-2줄)**', '**우리 회사 공식 (있다면)**' (수식 1줄), '**무엇을 포함 / 제외**' (bullets — 명확히 — 'free trial 포함? 일시정지 계정 포함?'), '**언제 측정 / 누가 owner**' (1줄), '**자주 헷갈리는 다른 메트릭**' (bullets — 'X와 Y 차이'), '**우리 기준 (벤치마크)**' (1줄 — 우리 회사 기대 범위), '**대표 메트릭들:**' MRR, ARR, ACV, LTV, CAC, CAC payback, NRR, GRR, Logo churn, Revenue churn, MAU/DAU, Activation rate, Time to first value, NPS, CSAT, MQL, SQL, Pipeline coverage, Win rate, Sales cycle.\n\n회사 컨텍스트 (단계 / 비즈모델):\n${text}`,
  translate_ko_to_singapore_english: (text) =>
    `Translate the Korean text below into natural Singapore English (Singlish 가능한 가벼운 사용). 격식 ('you' 표준) 원문에 맞춤. 친근한 컨텍스트에서 'lah', 'lor', 'meh' 같은 sentence-final particles 자연스럽게. Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  team_growth_plan_individual_ko: (text) =>
    `Build a Korean individual growth plan doc — co-created by an engineer + their manager for 6-month / 1-year growth. Use 해요체. Markdown: '**한 줄 (성장 방향)**' (1줄 — '다음 6개월 Y 방향으로 성장'), '**현재 강점 (3 bullets)**' (구체적), '**현재 발전 영역 (2 bullets)**' (구체적 — 시니어 레벨로 가기 위한 또는 다음 역할), '**6개월 목표 (3개 — measurable)**' (numbered — 각 'X 까지 Y 달성'), '**스킬 학습 (테이블)**' ('스킬 | 어떻게 배울지 | 매니저 지원 | 시한'), '**상호 멘토링 / 회사 외 활동**' (bullets), '**프로젝트 / 경험 기회**' (bullets — 어떤 프로젝트 노출), '**Check-in (테이블)**' ('시점 | 평가 항목 | 누구와'), '**1년 후 (이상적 자기)**' (1단락 — vision).\n\n개인 / 매니저 컨텍스트:\n${text}`,
  translate_ko_to_irish_english: (text) =>
    `Translate the Korean text below into natural Irish English (Hiberno-English). 격식 ('you' 표준) 원문에 맞춤. Use Irish English conventions where natural ('grand' for fine, 'craic', 'yer man'). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_30day_email_ko: (text) =>
    `Draft a Korean 30-day pre-renewal email — sent 30 days before contract expiry to a healthy customer. Use 해요체. 가치 재확인 + 짧은 다음 단계. Markdown: '**제목**' (1줄, 24자 이내 — '[고객사] 갱신 30일 전 — 짧은 노트'), '**본문**' (3 단락: 1) 1줄 안부 + 1줄 만기일 안내 — '30일 후 X일에 갱신 시점이에요', 2) 이번 계약 동안의 가치 1단락 — 구체적 데이터 + 1줄 인용, 3) 다음 단계 — '갱신 자동 진행 / 갱신 콜 30분 (일정 후보 3개) / 변경 사항 있으면 알려주세요'), '**P.S.**' (1줄 — '다년 또는 좌석 확장 옵션도 있으니 관심 있으시면 말씀 주세요').\n\n계약 / 가치 컨텍스트:\n${text}`,
  translate_ko_to_south_african_english: (text) =>
    `Translate the Korean text below into natural South African English. 격식 ('you' 표준) 원문에 맞춤. Use South African conventions ('robot' for traffic light, 'lekker', 'just now', 'shame' as sympathy). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  employee_referral_program_ko: (text) =>
    `Draft a Korean employee referral program announcement — sent by Head of Talent to whole company launching or relaunching the program. Use 해요체. 진심 + 명확 + 보상. Markdown: '**제목**' (1줄, 24자 이내 — '추천 채용 프로그램 시작 / 갱신'), '**본문**' (4 단락: 1) 1줄 — 우리 채용의 X%가 추천에서 옴 + 함께 일할 사람 같이 데려와 달라는 진심, 2) 어떤 사람을 찾고 있나 — 직군 / 레벨 / 회사 fit (1단락 — 빈말 X), 3) 보상 — 일하기 시작 후 N일 + 채용 확정 후 보너스 / 양쪽 모두에게 + 보너스 명확히, 4) 추천 방법 — 폼 링크 / Slack 채널 / 본인 1:1 가능), '**P.S.**' (1줄 — 다양성 강조 — '추천이 우리 다양성을 줄일 수도 있어요. 신경 써주세요').\n\n프로그램 / 회사 컨텍스트:\n${text}`,
  translate_ko_to_new_zealand_english: (text) =>
    `Translate the Korean text below into natural New Zealand English (Kiwi English). 격식 ('you' 표준 — 친근) 원문에 맞춤. Use NZ conventions ('jandals' for flip-flops, 'sweet as', 'choice', 'bach' for vacation home, Māori loanwords where natural). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_advisory_board_invite_ko: (text) =>
    `Draft a Korean customer advisory board (CAB) invite — sent to 8-12 strategic customers inviting them to join our advisory board (quarterly meetings, exec-level). Use 해요체. 격조 + 명확 + 진심. Markdown: '**제목**' (1줄, 28자 이내 — '[회사명] Customer Advisory Board 초대'), '**본문**' (4 단락: 1) 1-2줄 — 왜 그분 — 우리가 본 그쪽 영향력 / 식견, 2) CAB이 무엇인가 — 분기 1회 미팅 / virtual + 연 1회 in-person / 12명 한정 / exec-level — 명확히, 3) 그쪽이 얻는 것 — 로드맵 사전 영향 / 동료 네트워크 / NDA 하에 우리 strategy 공유 — 구체적, 4) 그쪽이 commit 해주실 것 — 분기 90분 + 분기 사이 짧은 인풋 + 사례 공개 1-2회 — 명확히), '**다음 단계**' (1줄 — 'X 까지 답장 + 첫 미팅 일정 후보 3개').\n\nCAB 컨텍스트:\n${text}`,
  translate_ko_to_hong_kong_english: (text) =>
    `Translate the Korean text below into natural Hong Kong English. 격식 ('you' 표준) 원문에 맞춤. Use HK English conventions where natural (직역적 idioms + Cantonese borrowings 자연스럽게). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_hiring_kickoff_ko: (text) =>
    `Build a Korean engineering hiring kickoff doc — kicked off when opening a new req, aligns hiring manager + recruiter + interviewers. Use 합쇼체. Markdown: '**한 줄 (포지션)**' (1줄 — '[직책 + 레벨], 시한, 헤드카운트 #'), '**왜 채용하나요 (Why)**' (1단락 — 비즈니스 정당화), '**Job description 핵심**' (bullets — 3-5개 — 무엇을 / 왜), '**Must-have vs Nice-to-have (테이블)**' ('스킬 / 경험 | Must | Nice'), '**채용 루프 (단계 + 인터뷰어 + 평가 영역 — 테이블)**', '**Source 전략**' (bullets — 추천 / agency / inbound / outbound), '**시한**' (테이블 — 'JD 게시 | 첫 인터뷰 | 오퍼 | 시작'), '**예산**' (1줄 — 보상 밴드), '**경쟁자**' (bullets — 우리 + 비슷한 회사가 같은 후보 경쟁), '**Hiring Manager / Recruiter / DRI**' (1줄).\n\n포지션 컨텍스트:\n${text}`,
  translate_ko_to_philippine_english: (text) =>
    `Translate the Korean text below into natural Philippine English. 격식 ('you' / 'Sir' / 'Madam' / 'Ma'am' 정중 자주) 원문에 맞춤. Use Philippine English conventions where natural ('sir/ma'am' frequent, 'po' borrowed in casual Taglish moments, 'comfort room' for restroom). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_signed_thank_you_ko: (text) =>
    `Draft a Korean customer renewal-signed thank-you email — sent within 24 hours of contract renewal signing. Use 해요체. 진심 + 다음 단계 + Exec 인사. Markdown: '**제목**' (1줄, 24자 이내 — '계약 갱신 감사합니다, [회사명]'), '**본문**' (4 단락: 1) 1-2줄 — 진심 어린 감사 + 1줄 — 다음 N개월 함께해 줘서 의미 있는 한 줄, 2) 우리가 다음 분기에 그쪽을 위해 할 1-2가지 — 구체적 commit (자랑 X), 3) 누가 도울 것 — CSM / 솔루션 엔지니어 / Exec sponsor — 이름 + 연락처, 4) 짧은 부탁 — '5분 만에 갱신 결정 도와준 한 가지' 알려달라 — 다른 고객 돕는 데 사용), '**Exec 서명**' (CEO / VP 사인 + 직접 휴대전화).\n\n갱신 / 컨텍스트:\n${text}`,
  translate_ko_to_jamaican_english: (text) =>
    `Translate the Korean text below into natural Jamaican English (formal) or Jamaican Patois (Patwa, casual) — 입력 격식에 맞춰 선택. 격식 ('you' 표준 / Patwa는 친근) 원문에 맞춤. Reply with two sections: '**Translation**' (label '**Translation (English)**' or '**Patwa**') and '**번역 노트**' (3 bullets in Korean — including which register was chosen).\n\n원문:\n${text}`,
  customer_csm_intro_email_ko: (text) =>
    `Draft a Korean new CSM intro email — sent when a customer's CSM is changing (handoff). Use 해요체. 따뜻 + 인계 + 안심. Markdown: '**제목**' (1줄, 24자 이내 — '안녕하세요 [이름]입니다 — 새 CSM 인사'), '**본문**' (4 단락: 1) 1-2줄 — 본인 소개 (이름 / 경력 1줄) + 전임 CSM [전임자] 인계 받은 1줄 + 그분 잘 정리해 주셔서 감사, 2) 그쪽에 대해 이미 아는 것 — 회사 / 사용 패턴 / 최근 우리와의 history — 1단락, 빠르게 배움 보임, 3) 다음 30일 우리 함께 할 것 — '첫 30분 환영 콜 / 이번 분기 우선순위 정렬 / Q[N] QBR 시점', 4) 본인 연락 채널 + 시간대 + 응답 SLA), '**P.S.**' (1줄 — 본인 개인 한 줄 — 인간미).\n\n고객 / 전임 컨텍스트:\n${text}`,
  translate_ko_to_kenyan_english: (text) =>
    `Translate the Korean text below into natural Kenyan English. 격식 ('you' 표준) 원문에 맞춤. Use Kenyan English conventions where natural ('chai' for tea, 'matatu' for shared van, Swahili borrowings like 'jambo', 'asante'). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  eng_team_summit_outline_ko: (text) =>
    `Build a Korean engineering team summit outline (1-2일 행사, 분기마다, 회사 미션 정렬 + 깊은 토론). Use 합쇼체. Markdown: '**Summit 한 줄**' (1줄 — 시기 / 장소 / 핵심 목표 1개), '**참석자**' (bullets — 부서 / 인원 수), '**Pre-work (1주 전)**' (bullets — 사전 readings / 사전 답변), '**Day 1 (테이블)**' ('시간 | 세션 | 진행자 | 산출물'), '**Day 2 (테이블)**' (동일 형식), '**의사결정 형식**' (1줄 — 'CEO 최종 / 합의 / 표결'), '**참여 방식**' (bullets — 인터랙티브 / 발표 / 워크숍 비율), '**휴식 / 식사 / 사회**' (bullets), '**Summit 후 follow-up**' (bullets — 결정 doc 시한 / 사내 share / 액션 owner).\n\nSummit 컨텍스트:\n${text}`,
  translate_ko_to_nigerian_english: (text) =>
    `Translate the Korean text below into natural Nigerian English. 격식 ('you' / 'Sir' / 'Ma' 정중 자주) 원문에 맞춤. Use Nigerian conventions where natural ('How far' for hello casual, 'Well done' as greeting, 'kindly' very frequent). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_referral_thanks_email_ko: (text) =>
    `Draft a Korean customer referral thank-you email — sent when a customer has actually referred someone and that referral signed up. Use 해요체. 진심 + 보상 + 다음 단계. Markdown: '**제목**' (1줄, 26자 이내 — '진심으로 감사해요, [이름]님'), '**본문**' (3 단락: 1) 1-2줄 — 추천 사실 알게 됨 + 1줄 진심 — '[추천된 회사] 정말 좋은 fit이에요', 2) 보상 — 구체적 (크레딧 / 기프티콘 / 무료 X개월 / 기부) + 언제 / 어떻게 받는지 명확히, 3) 짧은 다음 단계 — '추천 더 있으시면 X 링크 / 우리도 그쪽 알리고 싶은 partner가 있어요'), '**P.S.**' (1줄 — '추천된 분께도 우리가 잘 하는지 알려주세요').\n\n추천 / 컨텍스트:\n${text}`,
  translate_ko_to_ghanaian_english: (text) =>
    `Translate the Korean text below into natural Ghanaian English. 격식 ('you' 표준) 원문에 맞춤. Use Ghanaian English conventions where natural (Akan / Twi borrowings like 'akwaaba' welcome, 'ɛyɛ' good in casual). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_security_training_outline_ko: (text) =>
    `Build a Korean internal security training outline — annual security awareness training for all employees. Use 합쇼체. 짧 + 사례 위주 + 실용. Markdown: '**한 줄 (목표)**' (1줄 — '이 트레이닝 후 직원이 X 할 수 있어야 함'), '**총 시간**' (1줄 — '30분 영상 + 10분 퀴즈'), '**모듈 (numbered, 각 5-7분)**' (1) Phishing — 사례 3개 + 어떻게 알아채나, 2) 비밀번호 + MFA — 우리 도구 + 베스트 프랙티스, 3) 데이터 분류 — 공개 / 내부 / 비밀 / 극비 + 사례, 4) BYOD + 원격 근무 보안, 5) 사고 보고 — 신고 채널 / 시한, 6) 사회 공학 — 사례 + 거절 가이드), '**퀴즈 (5문제)**' (numbered + 정답 + 1줄 설명), '**완료 기준**' (1줄 — 'X점 이상 + 영상 시청 확인'), '**완료 시한**' (1줄), '**문의**' (1줄 — Security 채널 / DPO).\n\n회사 / 위험 컨텍스트:\n${text}`,
  translate_ko_to_tanzanian_english: (text) =>
    `Translate the Korean text below into natural Tanzanian English. 격식 ('you' 표준) 원문에 맞춤. Use Tanzanian conventions where natural (Swahili borrowings like 'mzungu', 'pole', 'karibu'). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_quarterly_open_house_ko: (text) =>
    `Draft a Korean customer quarterly open house event invite + agenda — 60분 virtual event, 우리가 분기 출시 / 로드맵을 고객에게 보여주고 Q&A. Use 해요체. Markdown: '**제목 (이메일)**' (1줄, 28자 이내 — '[분기] Open House 초대 — 60분 + Q&A'), '**본문 (이메일)**' (2 단락 — 무엇 / 언제 / 왜 와야 하는지 1줄씩 + 등록 링크), '**이벤트 어젠다 (60분)**' (numbered — '5분 환영 / 15분 분기 출시 데모 / 15분 다음 분기 로드맵 (NDA 하) / 15분 사용자 사례 (고객 1명 인터뷰) / 10분 Q&A'), '**참석자 안내**' (bullets — Slack 채널 / 사전 질문 폼 / 녹화 공유 여부), '**준비 사항**' (bullets — Zoom / 자료 사전 download / 등록 마감).\n\n분기 / 출시 컨텍스트:\n${text}`,
  translate_ko_to_caribbean_english: (text) =>
    `Translate the Korean text below into natural Caribbean English (Jamaica / Trinidad / Barbados 표준 영어). 격식 ('you' 표준) 원문에 맞춤. Caribbean rhythm 자연스럽게 ('me' 'go' patterns 친근). Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_pmf_interview_questions_ko: (text) =>
    `Build a Korean PMF customer interview question script — 45-60분 1:1 interview, follow-up to PMF survey. Use 해요체. 사용자 말하게 하는 open question 위주. Markdown: '**인터뷰 한 줄 목적**' (1줄), '**Warm-up (5분)**' (numbered — 본인 / 직책 / 1주 평균 일과 1줄), '**제품 발견 (10분)**' (numbered: 1) 우리 도구를 어떻게 처음 알게 됐어요? 2) 그 전에 이 문제를 어떻게 해결했어요? 3) 시도했던 다른 도구 있어요? 왜 떠났어요?), '**핵심 가치 (15분)**' (numbered: 1) 우리 도구가 가장 도움 된 1가지 사례 말해주세요, 2) 그게 없었으면 어떻게 됐을까요? 3) 우리가 사라지면 무엇으로 대체할 수 있어요?), '**페인 / 개선 (15분)**' (numbered: 1) 가장 짜증났던 1순간, 2) 만들고 싶은데 우리에게 없는 1가지, 3) 사용 안 하는 기능 있어요?), '**확장 (10분)**' (numbered: 1) 누구에게 추천하고 싶나요? 왜? 2) 추천하고 싶지 않은 사람은? 3) 더 많이 쓸 수 있게 우리가 무엇 해주면 좋을까요?), '**마무리 (5분)**' (numbered — 인터뷰 인상 / 추가 인터뷰 가능 / follow-up 동의).\n\n제품 / 사용자 컨텍스트:\n${text}`,
  translate_ko_to_west_african_french: (text) =>
    `Translate the Korean text below into natural West African French (français d'Afrique de l'Ouest — Sénégal / Côte d'Ivoire / Mali 등). 격식 ('vous' 정중 / 'tu' 친근) 원문에 맞춤. Local terms / patterns 자연스럽게 ('palabre' for discussion, 'jah' or local borrowings). Reply with two sections: '**Traduction**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_compensation_change_announcement_ko: (text) =>
    `Draft a Korean internal compensation change announcement — sent by CEO / Head of People to whole company explaining a compensation philosophy change or salary band adjustment. Use 합쇼체. 매우 신중 + 솔직 + 명확. Markdown: '**제목**' (1줄, 28자 이내 — '보상 정책 변경 안내 — YYYY-MM-DD'), '**본문**' (5 단락: 1) 1-2줄 — 무엇이 변경되는지 직설적, 2) 왜 변경하는지 — 시장 / 회사 단계 / 공정성 / 데이터 — 솔직, 3) 누구에게 어떻게 영향을 — 인상 / 변화 없음 / 조정 — 명확 + 시한, 4) 우리가 다음 어떻게 진행 — 매니저 1:1 시점 / 새 레터 / Q&A 세션, 5) 본인의 진심 — 사람을 가장 우선하는 결정임을 보임), '**Q&A**' (1줄 — 'X 시간에 all-hands에서 답변 + 익명 질문 폼').\n\n변경 / 컨텍스트:\n${text}`,
  translate_ko_to_belgian_french: (text) =>
    `Translate the Korean text below into natural Belgian French (français de Belgique). 격식 ('vous' 정중 / 'tu' 친근) 원문에 맞춤. Use Belgian conventions where natural ('septante' for 70, 'nonante' for 90, 'GSM' for cellphone, 'pistolet' for bread roll). Reply with two sections: '**Traduction**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_health_dashboard_design_ko: (text) =>
    `Build a Korean customer health dashboard design doc — what metrics + how visualized for a CSM-facing dashboard. Use 합쇼체. Markdown: '**한 줄 (이 대시보드의 목적)**' (1줄 — 'CSM이 매주 X 결정을 빨리 내릴 수 있게'), '**대상 사용자**' (1줄 — CSM / 직책), '**Health Score 정의 (수식)**' (1단락 — 가중치 합산 — '활성 사용자 30% + adoption 20% + 티켓 sentiment 15% + 갱신 신호 20% + 챔피언 변동 15%'), '**개별 메트릭 (테이블)**' ('메트릭 | 정의 | source | 임계값 (Green/Yellow/Red) | 시각화 형식'), '**대시보드 레이아웃 (텍스트 wireframe)**' (1단락 — '상단: health score 큰 숫자 + 트렌드 / 좌측: alerts / 우측: action 권장 / 하단: 메트릭 그리드'), '**드릴다운**' (bullets — 각 메트릭에서 어떻게 deeper view로), '**Action 권장 룰**' (테이블 — '조건 | 권장 액션 | 자동화 여부'), '**알림**' (bullets — Slack 또는 이메일 트리거).\n\n시스템 / 메트릭 컨텍스트:\n${text}`,
  translate_ko_to_belgian_dutch: (text) =>
    `Translate the Korean text below into natural Belgian Dutch (Flemish — Vlaams). 격식 ('u' 정중 / 'je / jij' 친근 / 'ge / gij' Flemish 친근 표준) 원문에 맞춤. Use Flemish vocabulary where it differs from Netherlands Dutch ('GSM' for cellphone, 'frietjes', 'plezant' for fun). Reply with two sections: '**Vertaling**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_team_health_survey_quarterly_ko: (text) =>
    `Build a Korean quarterly internal team health survey — sent to all employees, results aggregated by team. Use 해요체. 익명 + 깊은. Markdown: '**제목 (이메일)**' (1줄 — '분기 팀 health survey — 10분, 익명'), '**본문 (이메일)**' (2 단락 — 왜 보내요 + 익명 보장 + 마감 시한), '**질문 카테고리 + 질문**' (h3 + 1-5 척도 질문 + open follow-up 각): 1) 명확성 + 정렬, 2) 자율성 + 임팩트, 3) 협업 + 관계, 4) 매니저 관계, 5) 성장 + 발전 기회, 6) 보상 + 인정, 7) 회사 방향 + 신뢰, 8) 본인 well-being + 번아웃, 9) 다양성 + 포용, 10) Open — '바꿀 수 있는 1가지', '**결과 공유 약속**' (1단락 — '집계 결과 X일 후 all-hands에서 공개 + 액션 commit').\n\n회사 / 컨텍스트:\n${text}`,
  translate_ko_to_netherlands_dutch: (text) =>
    `Translate the Korean text below into natural Netherlands Dutch (standaardnederlands). 격식 ('u' 정중 / 'je / jij' 친근) 원문에 맞춤. Use Netherlands vocabulary where it differs from Belgian Dutch ('mobieltje' for cellphone, 'patat' or 'friet' regional). Reply with two sections: '**Vertaling**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_handoff_email_csm_to_sales_ko: (text) =>
    `Draft a Korean customer handoff email — when a CSM sees a strong upsell / expansion opportunity and hands the customer to the Sales (AE) team. Use 해요체. 명확한 인계 + 고객 안내. Markdown: '**제목**' (1줄, 28자 이내 — '[고객사] 확장 논의 — [AE 이름]에게 인계'), '**본문**' (3 단락: 1) 1-2줄 — 본인 CSM + 그쪽 사용 / 성장 신호 본 1줄 — 'X 더 잘 도울 수 있는 단계라고 생각해요', 2) AE 소개 — 이름 + 경력 1줄 + 무엇을 도울 것 — '계약 옵션 / 추가 모듈 / 다년 가격' — 명확히, 3) 다음 단계 — '[AE]가 다음 48시간 내 연락 / 첫 미팅 일정 후보 3개 / 우리(CSM)도 계속 같이 도움'), '**P.S.**' (1줄 — '본인 CSM 역할은 변동 없어요, 계속 곁에 있어요').\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_swiss_italian: (text) =>
    `Translate the Korean text below into natural Swiss Italian (italiano svizzero — Ticino / Grigioni). 격식 ('Lei' 정중 / 'tu' 친근) 원문에 맞춤. Use Swiss Italian conventions where natural ('natel' for cellphone, regional vocabulary). Reply with two sections: '**Traduzione**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_pricing_objection_response_ko: (text) =>
    `Draft a Korean customer pricing objection response — sent by AE when a prospect says '비싸다 / 예산 안 된다'. Use 해요체. 가격 방어 X, 가치 reframe + 옵션 + 다음 단계. Markdown: '**제목**' (1줄, 26자 이내 — '가격 부분 — 같이 풀어볼게요'), '**본문**' (4 단락: 1) 1줄 — 우려 인정 + 정상적 반응 — '예산이 압박인 시기 이해해요', 2) 가치 reframe 1단락 — 우리가 본 비슷한 회사가 우리 도구로 절약 / 매출 증가한 데이터 — 구체적, 3) 3가지 옵션 — A: 작은 시작 (X 좌석부터) / B: 다년 + Y% / C: 분기 결제 옵션 — 명확 + 가격, 4) 본질 질문 — '예산 timing 문제인지 가격 자체인지' — open question), '**P.S.**' (1줄 — '결정자가 다른 분이면 같이 30분 통화 가능').\n\n견적 / 컨텍스트:\n${text}`,
  translate_ko_to_italian_dialect_neapolitan: (text) =>
    `Translate the Korean text below into natural Neapolitan Italian (napoletano — Naples 지역 dialect / 표준 이탈리아어와 다름). 친근한 톤이 표준. Reply with two sections: '**Traduzione (Napoletano)**' and '**번역 노트**' (3 bullets in Korean — include note that this is a regional dialect, not standard Italian).\n\n원문:\n${text}`,
  internal_strategy_change_memo_ko: (text) =>
    `Draft a Korean internal strategy change memo — sent by CEO / Founders to whole company explaining a major strategic shift (e.g., 시장 변경 / 제품 pivot / target customer 변경). Use 합쇼체. 솔직 + 비전 + 무엇이 변하고 무엇은 안 변하는지 명확. Markdown: '**제목**' (1줄, 28자 이내 — '회사 전략 변경 안내 — YYYY-MM-DD'), '**본문**' (5 단락: 1) 1-2줄 — 무엇이 변경되는지 직설적 — '오늘부로 우리는 X에서 Y로 방향을 바꿉니다', 2) 왜 — 어떤 데이터 / 어떤 깨달음 / 어떤 시장 변화 — 솔직, 3) 무엇이 변경되나 — 제품 / 고객 / 팀 / 우선순위 — 명확 + 시한, 4) 무엇은 변경 안 되나 — 미션 / 사람 / 가치 — 안심, 5) 우리가 함께 할 다음 — all-hands 시점 / 1:1 진행 / 질문 채널), '**개인적 한 줄**' (1줄 — 본인 진심).\n\n변경 / 컨텍스트:\n${text}`,
  translate_ko_to_italian_dialect_sicilian: (text) =>
    `Translate the Korean text below into natural Sicilian (sicilianu — Sicily 지역 dialect, 표준 이탈리아어와 매우 다름). 친근한 톤이 표준. Reply with two sections: '**Traduzzioni (Sicilianu)**' and '**번역 노트**' (3 bullets in Korean — include note that this is a regional language, often considered distinct from Italian).\n\n원문:\n${text}`,
  customer_q_and_a_template_blog_ko: (text) =>
    `Build a Korean customer Q&A blog template — interview-style blog post showcasing a customer's story. Use 해요체. 진정성 + 데이터 + 사람 냄새. Markdown: '**제목**' (1줄, 32자 이내 — '[고객 이름], [회사] — [한 줄 결과]'), '**부제**' (1줄 — 어떤 산업 / 회사 크기 / 사용 기간), '**Intro (1단락)**' (3-4줄 — 그 회사 + 인터뷰이 + 우리와의 관계 1줄), '**Q&A (5-7개)**' (각 'h3: 질문 / 본문: 인터뷰이 답변 1-2단락 — 사용자 목소리 유지, 너무 다듬지 말기'): 1) 우리 도구 발견 전 어떻게 해결? 2) 어떻게 우리를 알게 됐어요? 3) 도입 첫 30일 어땠어요? 4) 가장 크게 바뀐 1가지? 5) 측정 가능한 결과 (숫자 인용), 6) 우리에게 부족한 1가지, 7) 비슷한 회사에게 추천한다면 1가지, '**핵심 결과 박스 (사이드바)**' (bullets — 3개 큰 숫자), '**다음 액션 / CTA**' (1줄 — '이런 결과 보고 싶으시면 X').\n\n고객 / 인터뷰 raw:\n${text}`,
  translate_ko_to_italian_dialect_milanese: (text) =>
    `Translate the Korean text below into natural Milanese / Lombard (milanese / lombardo — Milan 지역 dialect). 친근한 톤이 표준. Reply with two sections: '**Tradüzión (Milanese)**' and '**번역 노트**' (3 bullets in Korean — include note that this is a regional language).\n\n원문:\n${text}`,
  internal_eng_blameless_culture_doc_ko: (text) =>
    `Draft a Korean engineering blameless culture doc — pinned in #engineering Slack, used to onboard new engineers + to reset culture after incidents. Use 해요체. 짧 + 사례 위주. Markdown: '**한 줄 (우리 신념)**' (1줄 — '실수는 사람이 아닌 시스템의 신호'), '**왜 blameless인가 (1단락)**' (3-4줄 — 두려움이 학습을 막음 + 우리가 더 빨리 개선되려면), '**우리가 하는 것 (3 bullets)**' (구체적 — 'postmortem에서 이름 대신 역할 사용 / Slack에서 책망 댓글 시 사적 DM으로 1:1 / 매니저가 항상 먼저 책임 모범'), '**우리가 안 하는 것 (3 bullets)**' (구체적 — '사고 보고서에서 누가 했나 부각 / 평가에 사고 연결 / 사고 commit 이력 hunt'), '**개인 책임 vs 시스템 책임 (1단락)**' (분리 가이드 — 'X 실수 = 시스템 갭 / 같은 실수 N회 = 매니저 1:1로 dev 코칭'), '**Q&A**' (3 bullets — 자주 묻는 우려).\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_swiss_romansh: (text) =>
    `Translate the Korean text below into natural Romansh (Rumantsch — Switzerland's fourth official language, Grigioni 지역). 격식 ('vus' 정중 / 'ti' 친근) 원문에 맞춤. Use Rumantsch Grischun (standardized form) by default. Reply with two sections: '**Translaziun**' and '**번역 노트**' (3 bullets in Korean — include note that Romansh has multiple variants).\n\n원문:\n${text}`,
  customer_satisfaction_followup_email_ko: (text) =>
    `Draft a Korean customer CSAT survey follow-up email — sent when a customer gives a low CSAT (1-3 of 5) after a support interaction. Use 해요체. 인정 + 진심 + 액션. Markdown: '**제목**' (1줄, 26자 이내 — '실망시켜 드려 죄송해요 — [티켓번호]'), '**본문**' (3 단락: 1) 1-2줄 — 낮은 점수 본 직후 보내는 이유 + 진심 어린 사과 — '우리가 부족했어요', 2) 무엇이 잘못됐는지 우리 측 정확한 인정 + 즉시 한 액션 (가능하면), 3) 짧은 부탁 — '10분만 직접 통화 가능? 그쪽 경험 직접 듣고 우리 개선에 쓰겠습니다' + 시간 후보 2개), '**P.S.**' (1줄 — 'CSAT 답을 다시 바꿔 달라고 부탁드리는 메일 아니에요, 그저 직접 들으려고요').\n\n티켓 / 응답 컨텍스트:\n${text}`,
  translate_ko_to_swahili_dialect: (text) =>
    `Translate the Korean text below into natural Swahili (Kiswahili — East African coast / Tanzania / Kenya / DRC). 격식 ('Bwana / Bibi' 정중 호칭 / 'wewe' 친근) 원문에 맞춤. Use East African Swahili conventions (Tanzanian Kiswahili sanifu as default). Reply with two sections: '**Tafsiri**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_co_marketing_brief_ko: (text) =>
    `Build a Korean customer co-marketing brief — when our customer agrees to do joint marketing (case study + webinar + blog + social). Use 해요체. 양쪽 win-win + 명확한 합의. Markdown: '**한 줄 (이 협업의 목적)**' (1줄 — '[고객사] × [우리] 공동 마케팅 — [목표]'), '**양쪽 win-win (테이블)**' ('항목 | 우리 win | 그쪽 win'), '**산출물 (테이블)**' ('자산 | 형식 | 누가 만들기 | 누가 검토 | 시한 | 어디서 배포'): 사례 스터디, 공동 웨비나, 공동 블로그, 소셜 contents, 이메일, '**메시지 정렬**' (1단락 — 어떤 핵심 메시지 / 톤 / 피할 표현), '**홍보 채널**' (bullets — 양쪽 채널 + 공동 채널), '**시한 (gantt 텍스트)**' (numbered — 주별), '**측정 지표**' (bullets — 양쪽이 측정하는 것), '**법무 / NDA / 사용 허가**' (1단락 + bullets), '**연락 담당 (양쪽)**' (1줄).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_amharic_dialect: (text) =>
    `Translate the Korean text below into natural Amharic (አማርኛ) with attention to common Ethiopian-Eritrean conversational forms (Tigrinya 또는 다른 Ge'ez script 언어 영향 가능). 격식 ('እርስዎ' 정중 / 'አንተ/አንቺ' 친근) 원문에 맞춤. Reply with two sections: '**ትርጉም**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_quality_doc_ko: (text) =>
    `Draft a Korean engineering quality doc — pinned in #engineering Slack, defines our quality bar across code / tests / shipping. Use 해요체. 짧 + Do / Don't 위주. Markdown: '**한 줄 (우리 quality 신념)**' (1줄 — '고객에게 손해 주는 결함은 우리에게 가장 큰 cost'), '**우리 quality 정의**' (1단락 — 무엇을 quality라고 부르나 — 결함 X + 다른 4가지 차원), '**Do / Don't (테이블)**' ('영역 | Do | Don\\'t | 예외'): 코드 리뷰, 테스트, 결함 분류, 배포, 핫픽스, '**Quality 게이트**' (numbered — PR 머지 / 배포 / 핫픽스 게이트 각각의 체크리스트), '**Q&A**' (3-5 bullets — 자주 묻는 우려).\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_thai_business: (text) =>
    `Translate the Korean text below into natural business Thai (ภาษาไทยทางธุรกิจ). Use highest 격식 ('คุณ' 정중 표준 / 'ท่าน' 매우 정중 — exec / 고객 / 공식 문서) 원문에 맞춤. Reply with two sections: '**คำแปล**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_first_renewal_letter_ko: (text) =>
    `Draft a Korean first-year renewal letter — sent by Exec sponsor / CEO when a customer is about to complete their first full year and renew. Use 해요체. 진심 + 함께한 성과 + 다음 약속. Markdown: '**제목**' (1줄, 28자 이내 — '[고객사], 함께한 첫 1년 — 진심으로'), '**본문**' (4 단락: 1) 1-2줄 — 첫 1년 함께해 줘서 감사 + 우리가 본 그쪽 1줄 변화 — 진심으로, 2) 함께한 성과 1단락 — 구체적 메트릭 / 결과 / 1줄 인용 (가능하면), 3) 다음 1년 약속 — 우리가 할 1-2가지 commit — '다음 1년 X / Y / Z 도와드리겠습니다' — 자랑 X, 4) 부탁 1줄 — '여전히 부족한 1가지 솔직히 알려주시면 다음 1년 reframe 출발점'), '**Exec 서명**' (CEO / VP — 손 글씨 느낌의 톤).\n\n고객 / 1년 컨텍스트:\n${text}`,
  translate_ko_to_vietnamese_business: (text) =>
    `Translate the Korean text below into natural business Vietnamese (tiếng Việt thương mại). Use formal 격식 ('Ông / Bà / Anh / Chị' 호칭 + 정중 동사 형식) 원문에 맞춤. Use Vietnamese business conventions where natural (Trân trọng 결어 / 'kính' prefix 정중). Reply with two sections: '**Bản dịch**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  competitive_intelligence_brief_ko: (text) =>
    `Build a Korean competitive intelligence brief — weekly / monthly digest, circulated to sales + product + marketing. Use 합쇼체. 객관적 + 데이터 + 액션. Markdown: '**한 줄 (이번 주 핵심)**' (1줄 — '경쟁사 X의 Y는 우리에게 Z 영향'), '**주요 경쟁사 활동 (테이블)**' ('경쟁사 | 활동 (출시 / 가격 / 인사 / 자금) | 출처 | 우리에게 영향'), '**Product news**' (bullets — 출시 / 기능 변경 + 우리 비교), '**Pricing news**' (bullets — 가격 변화 + 우리 영향), '**People moves**' (bullets — 임원 변동 / 채용 시그널), '**Funding / M&A**' (bullets — 자금 / 인수 + 의미), '**Customer signals**' (bullets — 고객이 경쟁사 언급한 횟수 / 패턴), '**액션 권장 (3가지)**' (numbered — 어떤 팀 / 무엇 / 시한), '**출처 / 참고 자료**' (bullets — 링크 placeholder).\n\n경쟁 raw 데이터:\n${text}`,
  translate_ko_to_indonesian_business: (text) =>
    `Translate the Korean text below into natural business Indonesian (Bahasa Indonesia bisnis). Use formal 격식 ('Anda' 정중 표준 / 'Bapak / Ibu' 호칭) 원문에 맞춤. Use Indonesian business conventions where natural. Reply with two sections: '**Terjemahan**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_invoice_received_thanks_ko: (text) =>
    `Draft a Korean short customer invoice-received thank-you email — sent right after a customer's payment is received. Use 해요체. 짧 + 따뜻 + 다음 안내. Markdown: '**제목**' (1줄, 22자 이내 — '결제 확인 + 감사합니다'), '**본문**' (2 단락: 1) 1-2줄 — '[송장번호] 결제 잘 받았어요, 감사합니다 + 영수증 첨부' + 적용된 기간 / 좌석 수 / 다음 결제일 — 명확히, 2) 1줄 — '궁금하거나 영수증 양식 다른 거 필요하면 답장 / 다음 분기 자동 결제 진행'), '**P.S.**' (1줄 — Finance 팀 연락처 placeholder).\n\n송장 / 결제 컨텍스트:\n${text}`,
  translate_ko_to_burmese_business: (text) =>
    `Translate the Korean text below into natural business Burmese (မြန်မာဘာသာ). Use formal 격식 ('ခင်ဗျား / ရှင်' 정중 표준 / 'အရှင် / အရှင်မ' 매우 정중) 원문에 맞춤. Use Burmese business conventions where natural. Reply with two sections: '**ဘာသာပြန်ဆိုချက်**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_internal_champion_doc_ko: (text) =>
    `Build a Korean customer internal champion enablement doc — given to a customer's internal champion (our power user) to help them sell our value internally. Use 해요체. 챔피언이 임원에게 보여줄 수 있는 1 페이지. Markdown: '**한 줄 (그쪽 회사 + 우리)**' (1줄 — '[회사명], [우리 도구]로 [핵심 성과]'), '**우리가 풀고 있는 문제 (1단락)**' (그쪽 회사에 맞춤 — 3-4줄), '**이번 분기 결과 (메트릭 박스)**' (3-4개 큰 숫자 + 1줄 설명), '**구체적 사례 (인용)**' (1단락 + 1줄 직접 인용 + 누가 인용), '**다음 12개월 그쪽이 더 얻을 수 있는 것 (3 bullets)**' (확장 / 새 모듈 / 다른 팀), '**예상 ROI (수식)**' (1단락 — 'X 좌석 × Y / 월 = Z, 그쪽이 절약하는 시간 / 비용 = W, ROI = (W - Z) / Z'), '**비슷한 회사 사례 (Reference)**' (bullets — 회사명 + 1줄), '**임원이 자주 묻는 질문 (Q&A — 3쌍)**' (테이블 — 'Q: ... / A: 1단락'), '**다음 단계 (CTA)**' (1줄 — '임원 30분 미팅, 우리 Exec sponsor + AE 동석').\n\n고객 / 챔피언 컨텍스트:\n${text}`,
  translate_ko_to_khmer_business: (text) =>
    `Translate the Korean text below into natural business Khmer (ភាសាខ្មែរ). Use formal 격식 ('លោក / លោកស្រី' 호칭 + 정중 표현) 원문에 맞춤. Use Khmer business conventions where natural. Reply with two sections: '**ការបកប្រែ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_postmortem_action_followup_ko: (text) =>
    `Draft a Korean engineering postmortem action follow-up — 2주 후 sent to incident 관련자 to verify action items were completed. Use 해요체. 짧 + 명확. Markdown: '**제목**' (1줄 — '[INC-NNNN] 액션 follow-up — 상태 확인'), '**본문**' (3 단락: 1) 1줄 — 사고 회상 + 2주 전 약속한 액션 N개 follow-up 시간, 2) 액션별 상태 — 테이블 (각 액션 / 담당 / 시한 / 상태 (Done / In progress / Blocked) / 완료 증거 (PR 링크 / 메트릭)), 3) 미완료 항목 — 누가 / 무엇 / 새 시한 / 블록 사유 — 책임 회피 X), '**다음 follow-up 시점**' (1줄 — '2주 후 다시 / 모두 done이면 종료').\n\n사고 + 액션 컨텍스트:\n${text}`,
  translate_ko_to_lao_business: (text) =>
    `Translate the Korean text below into natural business Lao (ພາສາລາວ). Use formal 격식 ('ທ່ານ' 정중 / 'ເຈົ້າ' 표준 친근) 원문에 맞춤. Use Lao business conventions where natural. Reply with two sections: '**ການແປ**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_data_export_request_response_ko: (text) =>
    `Draft a Korean response to a customer data export request — sent when a customer asks for a full data export (보통 churning / portability). Use 합쇼체. 정중 + 명확 + 시한. Markdown: '**제목**' (1줄, 26자 이내 — '데이터 export 요청 — 처리 안내 [Ref #]'), '**본문**' (4 단락: 1) 1-2줄 — 요청 수신 확인 + 처리 시한 1줄 (보통 X 영업일 안), 2) 본인 확인 절차 안내 — 누구 / 어떻게, 3) 어떤 형식으로 어떤 데이터를 — CSV / JSON / PDF + 무엇 포함 / 무엇 제외 (system metadata 등), 4) 우리가 보유 유지하는 것 — 법적 의무 / 백업 — 명확히 + 삭제 시한), '**문의**' (1줄 — DPO / 책임자 + 직접 연락처).\n\n요청 / 고객 컨텍스트:\n${text}`,
  translate_ko_to_mongolian_business: (text) =>
    `Translate the Korean text below into natural business Mongolian (Монгол хэл). Cyrillic script default. Use formal 격식 ('Та' 정중 / 'та бүхэн' 복수 정중) 원문에 맞춤. Use Mongolian business conventions where natural. Reply with two sections: '**Орчуулга**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_dx_survey_ko: (text) =>
    `Build a Korean engineering developer experience (DX) survey — quarterly, sent to all engineers. Use 해요체. 익명 + 깊은. Markdown: '**제목 (이메일 / 폼)**' (1줄 — '엔지니어 DX 분기 서베이 — 10분, 익명'), '**왜 (1줄)**' (1줄 — '우리 도구 / 프로세스가 우리를 돕고 있는지 측정'), '**섹션 + 질문 (각 1-5 척도 + open follow-up)**': 1) 빌드 / 테스트 / 배포 속도, 2) 코드 리뷰 속도 + 품질, 3) 인시던트 / oncall 부담, 4) 문서 / 발견성 (필요한 것 찾기 쉬움), 5) 도구 / 환경 (로컬 dev / CI / IDE), 6) 코드베이스 health (변경 두려움 / 테스트 신뢰), 7) 깊은 작업 시간 + 회의 부담, 8) 학습 / 성장 기회, 9) 다른 팀과의 협업 마찰, 10) Open — '바꿀 1가지', '**결과 공유**' (1단락 — 'X일 후 익명 결과 share + Top 3 액션 commit').\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_uzbek_business: (text) =>
    `Translate the Korean text below into natural business Uzbek (Oʻzbek). Latin script default. Use formal 격식 ('Siz' 정중 / 'Sizlar' 복수 정중) 원문에 맞춤. Use Uzbek business conventions where natural. Reply with two sections: '**Tarjima**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_lessons_learned_brief_ko: (text) =>
    `Build a Korean internal lessons-learned brief — written by AE / CSM 1-2 weeks after a lost deal or major customer churn. Use 합쇼체. 솔직 + 학습 위주, 변명 / blame 없게. Markdown: '**한 줄 (잃은 것)**' (1줄 — '[고객사] / [금액] / [잃은 시점] / 우리가 본 1가지 핵심 이유'), '**컨텍스트 (1단락)**' (3-4줄 — 어떤 deal이었나 / 누가 결정자 / 단계 / 경쟁), '**우리가 잘 한 것 (3 bullets)**' (구체적 — 발견 / 미팅 / 자료), '**우리가 잘 안 한 것 (3 bullets)**' (구체적 — 어디서 misstep, 솔직), '**고객 측 진짜 이유 (가설 + 데이터)**' (1단락 + bullets — 가격 / 시점 / 챔피언 / 경쟁사 / fit), '**다른 비슷한 deal에 적용할 학습 (3 bullets)**' (numbered — 앞으로 우리가 다르게 할 것), '**Playbook 업데이트 사항 (제안)**' (bullets — 어떤 문서 / 어떤 단계).\n\nDeal / 컨텍스트:\n${text}`,
  translate_ko_to_kazakh_business: (text) =>
    `Translate the Korean text below into natural business Kazakh (Қазақ тілі) — Cyrillic script default. Use formal 격식 ('Сіз' 정중 / 'Сіздер' 복수 정중) 원문에 맞춤. Use Kazakh business conventions where natural. Reply with two sections: '**Аударма**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_user_research_invite_ko: (text) =>
    `Draft a Korean customer user research invite — sent by Research / Product team asking customer for 30-60min remote interview. Use 해요체. 명확 + 보상 + 시간 부담 없게. Markdown: '**제목**' (1줄, 28자 이내 — '[고객명]님, 30분만 인터뷰 가능하실까요?'), '**본문**' (4 단락: 1) 1-2줄 — 본인 소개 + 우리가 그쪽 분께 묻고 싶은 이유 (구체적 — 어떤 사용 패턴 본 후), 2) 인터뷰 내용 1단락 — 무엇을 / 얼마나 / 어떻게 (Zoom / 녹화 동의 / 익명화 또는 inglish), 3) 보상 — 구체적 ($X 기프트카드 / 무료 N개월 / 기부 옵션 / 사례비) + 어떻게 받는지, 4) 일정 신청 — 본인 캘린더 링크 placeholder + 마감 시점), '**P.S.**' (1줄 — '시간 안 되시면 짧은 폼 5분 옵션도 있어요').\n\n리서치 / 사용자 컨텍스트:\n${text}`,
  translate_ko_to_kazakh_cyrillic: (text) =>
    `Translate the Korean text below into natural Kazakh (Қазақ тілі) — emphasize Cyrillic script. 격식 ('Сіз' 정중 / 'сен' 친근) 원문에 맞춤. Reply with two sections: '**Аударма (Cyrillic)**' and '**번역 노트**' (3 bullets in Korean — note about Latin alternative if helpful).\n\n원문:\n${text}`,
  internal_eng_review_template_ko: (text) =>
    `Build a Korean engineering performance review template — used by manager to write annual / half-annual reviews. Use 합쇼체. 구체적 + 사례 위주 + 균형. Markdown: '**Reviewee 한 줄**' (이름 / 직책 / 레벨 / 평가 기간), '**기간 임팩트 요약 (3-5 bullets)**' (각 bullet — '무엇을 / 누구에게 / 측정 가능한 결과 / 본인 기여 비중'), '**Technical 강점 (각 1단락 + 사례)**' (h3 1-3개), '**Engineering craft (각 1단락 + 사례)**' (h3 1-3개 — 코드 품질 / 시스템 사고 / 디버깅), '**Collaboration (각 1단락 + 사례)**' (h3 1-3개 — 협업 / 리더십 / 멘토링), '**Growth area (2-3개 — 각 1단락 — 현재 + 개선 방향 + 매니저 지원)**', '**제안 평가 (Rating)**' (1줄 — 'Exceeds / Meets / Below — 1줄 근거'), '**Calibration 노트 (다른 calibrator에게 컨텍스트)**' (1-2 bullets), '**다음 6개월 — 발전 액션 (2-3 numbered)**' (구체적 + 시한), '**승진 / 레벨 업 신호 (있다면)**' (1줄).\n\n임팩트 / 피드백 raw:\n${text}`,
  translate_ko_to_kyrgyz: (text) =>
    `Translate the Korean text below into natural Kyrgyz (Кыргыз тили). Cyrillic script default. 격식 ('Сиз' 정중 / 'сен' 친근) 원문에 맞춤. Reply with two sections: '**Котормо**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_signed_announcement_internal_ko: (text) =>
    `Draft a Korean internal Slack announcement when a customer renewal is signed — posted in #wins or #revenue. Use 해요체. 짧 + 호명 + 다음 단계. Markdown: '**한 줄**' (1줄 — '[고객사] 갱신 사인! [금액] / [기간]'), '**본문 (1단락)**' (2-3줄 — 누가 만들었나 — '@AE, @CSM, @Solutions Engineer' 호명 + 가장 큰 결정 요인 1줄), '**숫자 (테이블)**' ('지표 | 이번 갱신 | 이전 계약 | Δ'), '**다음 단계**' (1줄 — '내일 calendar에 다음 QBR 잡기 / 다음 분기 expansion 시도 계획'), '**축하 (1줄)**' (1줄 — 🎉).\n\n계약 / 컨텍스트:\n${text}`,
  translate_ko_to_turkmen: (text) =>
    `Translate the Korean text below into natural Turkmen (Türkmen dili). Latin script default. 격식 ('Siz' 정중 / 'sen' 친근) 원문에 맞춤. Reply with two sections: '**Terjime**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_capacity_planning_ko: (text) =>
    `Build a Korean engineering capacity planning doc — quarterly, used by Eng Manager to commit / push back on roadmap. Use 합쇼체. Markdown: '**한 줄 (다음 분기 우리 가능 범위)**' (1줄 — 'X 프로젝트 commit, Y는 stretch, Z는 못 함'), '**팀 인원 + 가용 capacity 계산 (테이블)**' ('이름 | 직책 | 풀타임 | 휴가 / 마일스톤 / 멘토링 차감 | 가용 weeks'), '**다음 분기 계획된 항목 (테이블)**' ('항목 | 추정 weeks | 인원 needs | 의존성 | 우선순위'), '**용량 vs 수요 갭 (1단락 + 표)**' (테이블 — '카테고리 | 가용 | 수요 | Δ'), '**Trade-off 옵션 (3가지)**' (numbered — '옵션 A: X 안 함 / B: 채용 가속 / C: 다른 팀 위탁'), '**추천 옵션 + 이유**' (1단락), '**채용 / 자원 요청**' (1줄 — 누구를 / 언제까지).\n\n팀 / 분기 컨텍스트:\n${text}`,
  translate_ko_to_tajik: (text) =>
    `Translate the Korean text below into natural Tajik (тоҷикӣ). Cyrillic script default. 격식 ('Шумо' 정중 / 'ту' 친근) 원문에 맞춤. Reply with two sections: '**Тарҷума**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_survey_results_share_ko: (text) =>
    `Draft a Korean customer-facing email sharing back survey results — sent after a customer survey to thank participants + share what we learned + what we'll do. Use 해요체. 진정성 + 데이터 + commit. Markdown: '**제목**' (1줄, 28자 이내 — '[설문] 결과 공유 + 우리가 할 것'), '**본문**' (4 단락: 1) 1줄 — 설문 응답 N% / N명 / 시간 내주신 감사, 2) 가장 큰 신호 1단락 — '여러분이 가장 자주 말씀해주신 1가지 + 우리가 어떻게 받아들였나', 3) 우리가 할 commit — bullets — '단기 X / 중기 Y / 장기 Z' — 구체적 + 시한 + 솔직 (할 수 없는 것은 못 한다고 인정), 4) 다음 — '진행 상황은 분기 update에서 공유 / 추가 의견 받는 채널 X'), '**P.S.**' (1줄 — '익명성 보장 + 개인 식별 가능 답변 처리 방법').\n\n설문 / 결과 raw:\n${text}`,
  translate_ko_to_baluchi: (text) =>
    `Translate the Korean text below into natural Baluchi (Balochi — بلۏچی). RTL 흐름. 격식 ('شما' 정중 / 'تو' 친근) 원문에 맞춤. Reply with two sections: '**ترجمه**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_health_review_template_ko: (text) =>
    `Build a Korean customer health review template — short structured form CSM fills out monthly for each account. Use 해요체. Markdown: '**고객 한 줄**' (회사 / 산업 / 계약 금액 / CSM), '**Health Score (1줄)**' (신호등 + 근거), '**메트릭 (테이블)**' ('메트릭 | 30일 trend | 90일 trend | benchmark'), '**관계 (3 bullets)**' (챔피언 / 임원 sponsor / 새 contact), '**최근 30일 활동 (테이블)**' ('날짜 | 활동 종류 | 결과 / 메모'), '**Open issues (티켓 + 비즈)**' (bullets), '**확장 / 추가 모듈 신호**' (bullets), '**위험 신호**' (bullets), '**다음 30일 액션 (numbered)**' (구체적 — 누가 / 무엇 / 시한), '**Exec sponsor 노출 필요?**' (1줄 — Yes/No + 이유).\n\n고객 / 데이터:\n${text}`,
  translate_ko_to_sindhi: (text) =>
    `Translate the Korean text below into natural Sindhi (سنڌي). RTL 흐름. 격식 ('اوهان' 정중 / 'تون' 친근) 원문에 맞춤. Reply with two sections: '**ترجمو**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_pm_org_strategy_doc_ko: (text) =>
    `Draft a Korean PM organization strategy doc — written by Head of Product to align PMs on what we're building / not building / how we work. Use 합쇼체. Markdown: '**한 줄 (PM 조직 미션)**' (1줄), '**우리가 책임지는 영역 (Product surface)**' (bullets), '**현재 PM 인원 + 배치 (테이블)**' ('PM 이름 | 영역 | 레벨 | 매니저'), '**이번 분기 전략적 베팅 (3-5개)**' (각 'h3 + 1단락 + 누가 책임'), '**우리가 하지 않을 것 (1단락)**' (3-5 bullets — 명확히), '**프로세스 / 의식**' (bullets — 주간 / 월간 / 분기 / OKR / planning), '**메트릭 (PM 조직 자체)**' (bullets — 출시 빈도 / 사용자 임팩트 / PM-Eng 만족도), '**채용 plan (이번 분기)**' (1줄 — N명 / 어떤 영역), '**OKR + 진행 상황 (테이블)**' ('KR | 목표 | 현재'), '**Open question (3 bullets)**' (PM 조직 차원에서 답을 찾아야 할 것).\n\nPM 조직 / 컨텍스트:\n${text}`,
  translate_ko_to_sorbian: (text) =>
    `Translate the Korean text below into natural Upper Sorbian (Hornjoserbsce — Slavic minority language in Germany). 격식 ('Wy' 정중 / 'ty' 친근) 원문에 맞춤. Reply with two sections: '**Přełožk**' and '**번역 노트**' (3 bullets in Korean — note that Lower Sorbian also exists, this uses Upper).\n\n원문:\n${text}`,
  customer_lifecycle_email_d100_ko: (text) =>
    `Draft a Korean customer lifecycle email at Day 100 — sent to customers who have been active for ~100 days, milestone moment. Use 해요체. 진심 + 데이터 + 다음 레벨 제안. Markdown: '**제목**' (1줄, 24자 이내 — '100일 함께 — 의미 있는 시점이에요'), '**본문**' (4 단락: 1) 1-2줄 — 100일 함께 감사 + 첫 100일 가장 큰 성과 1줄 (그쪽 측), 2) 누적 데이터 1단락 — '지금까지 X 회 사용 / Y 명 팀원 / Z 기능 활성화' — 구체적 + 비슷한 고객 비교, 3) 다음 레벨 3 bullets — '대부분 100일 이후 사용자가 시도하는 것 (검증된 단계)' — 강제 X 부담 X, 4) 부탁 1줄 — '100일 함께한 한 가지 솔직한 피드백 + 5분 통화 옵션'), '**P.S.**' (1줄 — 100일 기념 작은 보상 또는 무료 모듈 trial).\n\n고객 / 100일 데이터:\n${text}`,
  translate_ko_to_frisian: (text) =>
    `Translate the Korean text below into natural West Frisian (Frysk — Friesland, Netherlands). 격식 ('jo' 정중 / 'dy' 친근) 원문에 맞춤. Reply with two sections: '**Oersetting**' and '**번역 노트**' (3 bullets in Korean — note that East and North Frisian also exist, this uses West).\n\n원문:\n${text}`,
  internal_exec_decision_brief_template_ko: (text) =>
    `Build a Korean exec decision brief template — 1 페이지, sent to CEO / Exec team for a decision request. Use 합쇼체. 짧 + 명확 + 비즈에 강결합. Markdown: '**제목 (Decision request)**' (1줄, 32자 이내 — '결정 요청: [한 줄 제안]'), '**TL;DR (3 bullets)**' (각 1줄 — 무엇 / 왜 / 추천), '**문제 (Why now — 1단락)**' (3-4줄 — 데이터 + timing), '**고려한 옵션 (테이블)**' ('옵션 | 비용 | 시간 | 위험 | 영향 | 추천 여부'), '**우리 추천 + 근거 (1단락)**' (3-4줄), '**위험 / mitigation**' (bullets — Top 3), '**필요한 결정 (Yes/No 질문 1-2개)**' (numbered — exec가 답하기 쉽게), '**시한 + 다음 단계**' (1줄 — '결정이 X 까지 필요, 결정 후 Y 진행'), '**누가 영향 (RACI 간단)**' (1줄), '**부록 / 자세한 자료**' (bullets — 링크 placeholder).\n\n결정 / 컨텍스트:\n${text}`,
  translate_ko_to_walloon: (text) =>
    `Translate the Korean text below into natural Walloon (Walon — Romance minority language in southern Belgium / France). 격식 ('vos' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Ratourneure**' and '**번역 노트**' (3 bullets in Korean — note this is a regional Romance language distinct from French).\n\n원문:\n${text}`,
  customer_quarterly_innovation_share_ko: (text) =>
    `Draft a Korean quarterly customer innovation share email — sent by Product / CEO to all customers showing off the last 90 days of shipped features. Use 해요체. 자랑 X, 사용자에게 가치 중심 톤. Markdown: '**제목**' (1줄, 28자 이내 — '[분기] 출시 정리 — 한 번에 보기'), '**본문**' (5 단락: 1) 1-2줄 — 분기 인사 + 우리가 출시한 N가지 1줄 요약, 2) Top 3 큰 출시 — 각 h3 + 1단락 (무엇 / 왜 / 어떻게 시도) + 직접 사용 가이드 링크 placeholder, 3) 작은 개선 7-10개 — bullets — 사용자가 자주 묻던 것 — quick 표시, 4) 다음 분기 미리 보기 — 2-3 bullets (NDA 아래 큰 항목), 5) 부탁 — '20분 회의로 사용 경험 공유 받고 싶어요, 새 기능 만들 때 참고'), '**P.S.**' (1줄 — 분기 customer open house 일정 + 등록 링크).\n\n분기 / 출시 컨텍스트:\n${text}`,
  translate_ko_to_chechen: (text) =>
    `Translate the Korean text below into natural Chechen (Нохчийн мотт). Cyrillic script default. 격식 ('Шу' 정중 또는 복수 / 'хьо' 친근) 원문에 맞춤. Reply with two sections: '**Гочдар**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_decision_tree_ko: (text) =>
    `Build a Korean customer renewal decision tree doc — used by CSM 60 days before renewal to determine motion (auto / soft / hard / churn risk). Use 합쇼체. Markdown: '**한 줄**' (1줄 — '이 문서는 N일 전 사용 / 갱신 단계 결정용'), '**Decision tree (텍스트 ASCII)**' (1단락 — root → 분기별 결정), '**Decision criteria (테이블)**' ('신호 | Auto 갱신 OK | Soft motion | Hard motion | At risk'), '**Auto motion**' (1단락 — 어떤 고객 / 어떤 메일 / CSM 인볼브 최소화), '**Soft motion**' (1단락 — CSM 30분 콜 / 가치 reframe), '**Hard motion**' (1단락 — Exec 노출 / AE 인볼브 / 가격 협상), '**Churn risk motion**' (1단락 — 즉시 escalate / Exec sponsor / save plan), '**자주 일어나는 엣지 케이스 (3 bullets)**' (각 추천 motion + 이유), '**다음 단계 (CSM에게)**' (1줄 — 'X 까지 본인 portfolio 모든 갱신 motion 정해두기').\n\n포트폴리오 컨텍스트:\n${text}`,
  translate_ko_to_chuvash: (text) =>
    `Translate the Korean text below into natural Chuvash (Чӑваш чӗлхи). Cyrillic script default. 격식 ('Эсир' 정중 또는 복수 / 'эсӗ' 친근) 원문에 맞춤. Reply with two sections: '**Куҫарни**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_rfc_template_ko: (text) =>
    `Build a Korean engineering RFC (Request for Comments) template — used for non-trivial technical decisions that need cross-team review. Use 합쇼체. Markdown: '**RFC ID + 제목**' (1줄 — 'RFC-NNNN: 무엇을'), '**상태**' (1줄 — Draft / In review / Accepted / Rejected / Superseded), '**저자 + 검토자 + 마감**' (1줄), '**TL;DR (3 bullets)**' (각 1줄), '**Background / Problem**' (2-3단락 — 왜 이 문제 / 왜 지금 / 영향 범위), '**Proposed solution (1단락 + 다이어그램 placeholder)**', '**기술적 세부 (필요한 만큼 깊이)**' (코드 예시 / 데이터 모델 / API 시그니처), '**Alternatives considered (각 h3 + Pros / Cons + 왜 안 골랐는지)**' (2-3개), '**Backwards compatibility**' (1단락 — breaking 여부 / migration 경로), '**Security / Privacy / 컴플라이언스**' (bullets), '**Rollout plan**' (numbered — 단계 + flag + 측정), '**Open questions**' (bullets), '**Decision log (review 코멘트 요약)**' (날짜 + 결정).\n\n변경 컨텍스트:\n${text}`,
  translate_ko_to_yakut: (text) =>
    `Translate the Korean text below into natural Sakha / Yakut (Саха тыла). Cyrillic script default. 격식 ('эһиги' 정중 또는 복수 / 'эн' 친근) 원문에 맞춤. Reply with two sections: '**Тылбаас**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_email_intro_to_advisory_ko: (text) =>
    `Draft a Korean warm email intro — connecting an advisor / mentor with one of our customers (CEO → customer CEO 또는 임원). Use 해요체. 짧 + 명확 + 양쪽 동의 가정. Markdown: '**제목**' (1줄, 28자 이내 — '[A 이름] ↔ [B 이름] 소개'), '**본문**' (3 단락: 1) 1-2줄 — 양쪽 1줄 소개 + 왜 두 분이 연결되면 좋은 1줄, 2) [A]가 [B]에게 — 1단락 — 무엇에 대해 / 왜 / 무엇을 부탁하면 좋을지, 3) 다음 단계 — '두 분이 직접 이야기 잡으셔서 진행 / 저는 빠질게요'), '**참고**' (1줄 — 도움이 필요하면 다시 말씀해 주시면 follow-up).\n\nA / B / 컨텍스트:\n${text}`,
  translate_ko_to_bashkir: (text) =>
    `Translate the Korean text below into natural Bashkir (Башҡорт теле). Cyrillic script default. 격식 ('һеҙ' 정중 또는 복수 / 'һин' 친근) 원문에 맞춤. Reply with two sections: '**Тәржемә**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_pm_okr_template_ko: (text) =>
    `Build a Korean annual PM team OKR template — written at year-start, aligns the PM organization on annual objectives. Use 합쇼체. Markdown: '**연도 + 한 줄**' (1줄 — 'YYYY PM 조직 한 줄 목표'), '**회사 미션 + 회사 연간 O 인용**' (bullets), '**PM 조직 O 1 (Objective)**' (1줄 + 이유 1단락), '**KR 1.1 / 1.2 / 1.3**' (각 — measurable + 시한 + 측정 방법 + 가중치), '**PM 조직 O 2**', '**PM 조직 O 3**', '**Operating 메트릭 (Objective 외에도 측정할 것)**' (bullets — 출시 빈도 / 사용자 만족 / 협업 NPS), '**분기별 마일스톤**' (테이블 — 'Q1 | Q2 | Q3 | Q4'), '**위험 / 가정**' (bullets — 변하면 OKR 재논의 트리거), '**OKR 리뷰 의식**' (1줄 — '매주 PM standup / 매월 health check / 분기 calibration').\n\nPM 조직 / 컨텍스트:\n${text}`,
  translate_ko_to_tatar: (text) =>
    `Translate the Korean text below into natural Tatar (Татар теле). Cyrillic script default. 격식 ('Сез' 정중 또는 복수 / 'син' 친근) 원문에 맞춤. Reply with two sections: '**Тәрҗемә**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_pricing_grandfather_email_ko: (text) =>
    `Draft a Korean customer pricing grandfather email — sent to existing customers when we change pricing, telling them they're protected. Use 해요체. 진심 + 명확 + 안심. Markdown: '**제목**' (1줄, 26자 이내 — '가격 변경 + 그쪽은 기존 가격 유지'), '**본문**' (3 단락: 1) 1-2줄 — 우리가 가격 정책 바꾼 사실 + 그쪽은 기존 가격 유지된다는 결론 먼저 (안심), 2) 왜 변경했나 1단락 + 우리가 그쪽을 grandfather 하는 이유 — '함께한 시간 / 신뢰', 3) 영향 — 그쪽 가격 유지 기간 / 좌석 추가 시 옵션 / 만기 시 결정 — 명확히), '**P.S.**' (1줄 — 질문 / 우려 있으면 CSM에게 직접 답장).\n\n가격 / 컨텍스트:\n${text}`,
  translate_ko_to_buryat: (text) =>
    `Translate the Korean text below into natural Buryat (Буряад хэлэн). Cyrillic script default. 격식 ('Та' 정중 / 'ши' 친근) 원문에 맞춤. Reply with two sections: '**Оршуулга**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_strategic_review_pre_brief_ko: (text) =>
    `Build a Korean strategic customer review pre-brief — written by AE + CSM before a major exec-level review for a top-10 customer. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 산업 / 우리에게 매출 % / 전략적 중요도), '**관계 history (1단락)**' (3-4줄 — 처음 사인 / 큰 마일스톤 / 가장 가까운 챔피언), '**고객 측 우리에 대한 sentiment**' (1줄 — 신호등 + 근거), '**우리의 가치 (지난 12개월)**' (3 bullets — 메트릭 + 사례), '**전략 정렬**' (1단락 — 그쪽 회사 미션과 우리 도구 어떻게 연결), '**열린 issue / 우려**' (bullets — 솔직히), '**확장 / 추가 기회**' (bullets — 모듈 / 좌석 / 다른 사업부), '**경쟁 위험 (있다면)**' (1단락 — 경쟁사가 그쪽에 어떻게 접근하나), '**리뷰에서 commit 가능한 1-2가지**' (bullets — Exec ready), '**리뷰에서 받고 싶은 정보 1-2가지**' (bullets — 우리가 그들로부터 배워야 할 것), '**참석자 (양쪽)**' (테이블).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_kalmyk: (text) =>
    `Translate the Korean text below into natural Kalmyk (Хальмг келн). Cyrillic script default. 격식 ('Та' 정중 / 'чи' 친근) 원문에 맞춤. Reply with two sections: '**Оршуулга**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_pm_eng_alignment_doc_ko: (text) =>
    `Draft a Korean PM-Engineering alignment doc — written when PM team and Eng team need to reset on how they work together (보통 quarter 마다 또는 마찰 발생 후). Use 해요체. Markdown: '**한 줄 (이 문서 목적)**' (1줄 — 'PM과 Eng가 ~ 방식으로 함께 일하기로 합의'), '**현재 상태 (1단락)**' (3-4줄 — 무엇이 잘 되고 무엇이 마찰 — 솔직), '**역할 분담 (테이블)**' ('의사결정 영역 | PM 책임 | Eng 책임 | 공동'), '**의식 (테이블)**' ('미팅 / 의식 | 빈도 | 누가 진행 | 산출물 / 결정'), '**문서 / 도구 (단일 source of truth)**' (bullets — PRD / RFC / 백로그 / 우선순위 / 진행 상태), '**우선순위 정렬 프로세스**' (1단락 — 매주 / 매 sprint / 매 quarter), '**갈등 해소 가이드**' (bullets — 'PM과 Eng 의견 다를 때 어디서 결정 / 누가'), '**Trial 기간 + 회고**' (1줄 — 'X 주 trial 후 retro').\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_avar: (text) =>
    `Translate the Korean text below into natural Avar (Авар мацӀ). Cyrillic script default. 격식 ('нуж' 정중 또는 복수 / 'мун' 친근) 원문에 맞춤. Reply with two sections: '**ТӀатичӀилъи**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_quarterly_listening_session_ko: (text) =>
    `Draft a Korean invitation + agenda for a quarterly customer listening session — small group (8-12 customers) with PM / Product leadership, agenda is mostly listening. Use 해요체. 진심 + 명확 + 적은 우리 말. Markdown: '**제목 (이메일)**' (1줄, 28자 이내 — '[분기] Customer Listening — 1시간, 진심으로 듣고 싶어요'), '**본문 (이메일)**' (3 단락 — 무엇 / 왜 그분들 초대 / 무엇 기대), '**이벤트 어젠다 (60분)**' (numbered — '5분 환영 + 룰 / 10분 그쪽 회사 / 일 안부 / 20분 우리 도구로 가장 짜증난 1가지 (1명씩) / 20분 만들었으면 좋겠는 1가지 (1명씩) / 5분 우리가 듣고 commit할 것 정리'), '**우리 룰 (이벤트 시작 때 share)**' (bullets — '우리는 말 적게 / 설명 / 변호 X / 평가 X / 익명 follow-up OK'), '**참석자 안내**' (bullets — Zoom / 녹화 / 자료 사후 share), '**우리 약속**' (1줄 — 'X 일 안에 들은 것 정리해서 share + Top 3 commit').\n\n분기 / 컨텍스트:\n${text}`,
  translate_ko_to_ossetian: (text) =>
    `Translate the Korean text below into natural Ossetian (Ирон æвзаг). Cyrillic script default. 격식 ('сымах' 정중 또는 복수 / 'ды' 친근) 원문에 맞춤. Reply with two sections: '**Тæлмац**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_promotion_calibration_ko: (text) =>
    `Build a Korean engineering promotion calibration doc — used in semi-annual eng-wide promotion committee meeting. Use 합쇼체. 균형 + 데이터 + 솔직. Markdown: '**Candidate 한 줄**' (이름 / 현재 레벨 → 제안 레벨 / 매니저), '**왜 지금**' (1단락 — timing / 회사 단계 / 팀 needs), '**임팩트 요약 (Top 3 — 각 1단락 + 데이터)**' (구체적 — 각 결과 / 본인 기여 / 협업 / 어려움 극복), '**다음 레벨 책임 (회사 ladder 인용)**' (bullets — 이 후보가 이미 보여준 vs 더 보여야 할 것), '**Calibration peers (같은 레벨 다른 후보 또는 이미 그 레벨인 사람과 비교)**' (1단락), '**Growth area (있다면)**' (bullets — 다음 레벨에서 작업할 것), '**잠재적 우려 / 반대 의견 예상**' (bullets — 솔직 + 대응), '**추천 (Strong yes / Yes / Hold)**' (1줄 + 1단락 근거), '**Hold이면 다음 평가 시점**' (1줄).\n\n후보 / raw 데이터:\n${text}`,
  translate_ko_to_ingush: (text) =>
    `Translate the Korean text below into natural Ingush (ГӀалгӀай мотт). Cyrillic script default. 격식 ('шу' 정중 또는 복수 / 'хьо' 친근) 원문에 맞춤. Reply with two sections: '**Гочдар**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_implementation_kickoff_call_agenda_ko: (text) =>
    `Build a Korean customer implementation kickoff call agenda — 60분 첫 콜, 계약 사인 후 첫 만남. Use 해요체. 명확 + 양쪽 정렬. Markdown: '**콜 한 줄**' (1줄 — 'X 출시 목표 + 첫 30분 정렬, 두 번째 30분 첫 단계'), '**참석자 (양쪽)**' (테이블 — '우리 / 그쪽 | 이름 | 역할'), '**Agenda (60분 — 테이블)**' ('시간 | 항목 | 진행 | 결과물'): '5분 환영 + 사람 소개 (1줄씩), 10분 그쪽 측 목표 (그쪽이 말함, 우리 듣기), 10분 우리 측 제안 implementation 단계 (우리 말함), 10분 정렬 — 무엇 우선 / 무엇 나중 / 무엇 제외, 10분 첫 30일 마일스톤 + 누가 무엇 + 시한, 5분 다음 콜 일정 / 채널 / SLA, 10분 buffer + Q&A', '**Pre-work (24시간 전)**' (bullets — 그쪽에 보내는 자료 / 우리가 미리 받아야 할 것), '**산출물**' (bullets — 첫 30일 mile / RACI / 책임자 / 다음 미팅), '**Follow-up email 시한**' (1줄 — '24시간 안 본인 follow-up 이메일').\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_lezgian: (text) =>
    `Translate the Korean text below into natural Lezgian (Лезги чӀал). Cyrillic script default. 격식 ('куьн' 정중 또는 복수 / 'вун' 친근) 원문에 맞춤. Reply with two sections: '**Таржума**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_negotiation_phone_script_ko: (text) =>
    `Draft a Korean customer renewal negotiation phone call script — 30-45분 콜, AE / CSM 협상 시. Use 해요체. 듣기 위주, 변호 X. Markdown: '**Opening (3분)**' (1단락 — 본인 안부 + 콜 목적 직설 — '갱신 이야기 + 진행 정렬'), '**Discovery (10-15분)**' (numbered open question 5-7개: 1) 지난 N개월 어땠어요?, 2) 가장 큰 가치 1줄?, 3) 어떤 부분이 짜증났어요?, 4) 다음 분기 / 1년 그쪽 우선순위?, 5) 우리에게 묻고 싶은 1가지?, 6) 갱신 결정에 영향 줄 1가지?, 7) 다른 옵션 검토 중인가요? — 솔직히), '**Pitch (5분)**' (1단락 — discovery 들은 후 우리가 다음 1년 commit할 2가지 + 가격 옵션 + 보너스), '**Negotiation (10분)**' (반박 처리 — '가격 안 됨' / '경쟁사 더 싸' / 'X 기능 없음' — 각 대응 1줄 + 다음 단계 옵션), '**Close (5분)**' (1단락 — 'X 까지 답변 + 우리가 보낼 자료 / 다음 미팅 일정'), '**Follow-up email 시한**' (1줄 — '24시간 안').\n\n고객 / 협상 컨텍스트:\n${text}`,
  translate_ko_to_kumyk: (text) =>
    `Translate the Korean text below into natural Kumyk (Къумукъ тил). Cyrillic script default. 격식 ('сиз' 정중 또는 복수 / 'сен' 친근) 원문에 맞춤. Reply with two sections: '**Таржума**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_oncall_rotation_doc_ko: (text) =>
    `Draft a Korean engineering on-call rotation doc — used to onboard new engineers and reset oncall expectations. Use 해요체. 짧 + 명확 + 보호 (번아웃). Markdown: '**한 줄 (왜 oncall)**' (1줄 — '24/7 시스템 / SLO 책임 vs 깊은 작업 균형'), '**로테이션 형식**' (1단락 — '1주 단위 / N명 / Primary + Secondary / 시간대'), '**Primary 책임 (bullets)**' (P0/P1 응답 시간 / 트리아지 / 사고 리더 / 핸드오프 doc), '**Secondary 책임 (bullets)**' (Primary 백업 / 운영 부담 분담), '**On-call 외 (bullets)**' (다른 팀원은 oncall 인터럽트 X), '**On-call 보호 (bullets)**' (oncall 주는 회의 최소 / 깊은 작업 면제 / 다음 주 회복 시간), '**보상**' (1줄 — 'X 보너스 또는 시간 off / 회사 정책 인용'), '**Escalation 경로 (테이블)**' ('상황 | 1차 | 2차 | exec'), '**도구**' (bullets — PagerDuty / Slack / runbook 위치), '**Handoff 의식**' (1단락 — 매주 X 시간 / 누가 / 양식).\n\n팀 / 시스템 컨텍스트:\n${text}`,
  translate_ko_to_karachay: (text) =>
    `Translate the Korean text below into natural Karachay-Balkar (Къарачай-Малкъар тил). Cyrillic script default. 격식 ('сиз' 정중 또는 복수 / 'сен' 친근) 원문에 맞춤. Reply with two sections: '**Кёчюрме**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_implementation_health_check_ko: (text) =>
    `Build a Korean customer implementation health check — sent by CSM at D+14 of implementation to verify everything is on track. Use 해요체. 짧 + 데이터 + 솔직. Markdown: '**한 줄**' (1줄 — '[고객사] implementation D+14 health check'), '**원래 약속 vs 현재 (테이블)**' ('마일스톤 | 약속 시한 | 현재 상태 | Δ | 신호'), '**기술적 셋업 (bullets)**' (SSO / data import / 통합 / 권한 / 데이터 검증 — 각 상태), '**팀 enablement (bullets)**' (admin 학습 / power user 학습 / end user 학습 / 도움 자료), '**관찰된 위험 (bullets)**' (구체적), '**우리가 한 / 할 액션 (bullets)**', '**그쪽이 한 / 할 액션 (bullets)**' (명확 + 시한), '**다음 14일 우선순위 3개 (numbered)**', '**Exec sponsor 노출 필요? (1줄 — Yes/No + 이유)**'.\n\n구현 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_balkar: (text) =>
    `Translate the Korean text below into natural Balkar (Малкъар тил — Karachay-Balkar과 같은 언어이지만 Balkar 변형 강조). Cyrillic script default. 격식 ('сиз' 정중 또는 복수 / 'сен' 친근) 원문에 맞춤. Reply with two sections: '**Кёчюрме**' and '**번역 노트**' (3 bullets in Korean — note shared linguistic continuum with Karachay).\n\n원문:\n${text}`,
  internal_pm_user_research_intake_ko: (text) =>
    `Build a Korean PM user research intake form — used by PM team to request structured research from the Research team. Use 합쇼체. Markdown: '**요청자 + 팀**' (1줄 — 이름 / PM 영역), '**요청 제목 (1줄)**' (1줄 — '무엇을 알고 싶은지'), '**필요한 시점**' (1줄 — '결정 시점 + 왜 그 시점'), '**왜 이 리서치가 필요 (1단락)**' (3-4줄 — 어떤 결정 / 어떤 영향 / 이미 알고 있는 것 / 빈틈), '**핵심 질문 (Top 3 — 답을 받고 싶은 것)**' (numbered), '**대상 사용자 (페르소나 / 행동 / 사용 단계)**' (bullets), '**선호 방법론**' (bullets — interview / survey / usability test / diary study — 또는 'Research가 권장'), '**모집 도움 (우리가 가능한 것)**' (bullets — 우리 데이터에서 X 명 추출 가능 / CSM이 N명 추천), '**결정 영향 우선순위 (1-5)**' (1줄 + 이유), '**산출물 (어떤 형태로 받고 싶나)**' (bullets — share-back doc / 슬라이드 / 짧은 영상), '**예산 / 제약**' (1줄).\n\n요청 컨텍스트:\n${text}`,
  translate_ko_to_nogai: (text) =>
    `Translate the Korean text below into natural Nogai (Ногай тили). Cyrillic script default. 격식 ('сиз' 정중 또는 복수 / 'сен' 친근) 원문에 맞춤. Reply with two sections: '**Аударма**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_lost_postmortem_ko: (text) =>
    `Build a Korean customer renewal-lost postmortem — written by CSM + AE 1-2 weeks after a customer chose not to renew. Use 합쇼체. 솔직 + 학습 + blame 없게. Markdown: '**한 줄 (잃은 것)**' (1줄 — '[고객사] / [금액 / 좌석] / [잃은 시점]'), '**고객 측 공식 이유 (1줄)**' (그쪽이 말한 표면 이유), '**우리 가설 (실제 이유 — 1단락)**' (3-4줄 + bullets — 가격 / 기능 / 챔피언 / 경쟁사 / 사용 / fit), '**Health 신호 timeline (테이블)**' ('월 | health | 신호 | 우리 액션'), '**우리가 본 가장 큰 미스 (3 bullets)**' (구체적 — 어떤 미팅 / 어떤 결정), '**잘 한 것 (2 bullets)**' (그래도 인정), '**비슷한 고객에게 적용할 학습 (3 bullets)**' (numbered — 어떤 신호 / 어떤 액션), '**Playbook 업데이트 제안**' (bullets — health 정의 / save motion / discovery 깊이), '**Winback 가능성 (Yes / No / 6개월 후)**' (1줄 + 이유).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_komi: (text) =>
    `Translate the Korean text below into natural Komi (Коми кыв). Cyrillic script default. 격식 ('Ті' 정중 또는 복수 / 'тэ' 친근) 원문에 맞춤. Reply with two sections: '**Вуджӧдӧм**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_quarterly_qbr_action_items_ko: (text) =>
    `Build a Korean QBR action items doc — sent within 24 hours of a customer QBR, summarizing what both sides committed to. Use 해요체. 짧 + 명확 + 책임자 명확. Markdown: '**QBR 한 줄**' (1줄 — '[고객사] Q[N] QBR — YYYY-MM-DD'), '**참석자 (양쪽)**' (테이블), '**우리가 다음 분기 commit한 것 (테이블)**' ('항목 | 우리 담당 | 시한 | 어떻게 측정 / verify'), '**그쪽이 commit한 것 (테이블)**' ('항목 | 그쪽 담당 | 시한 | 우리가 어떻게 지원'), '**공동 commit (테이블)**' (양쪽 작업 — '항목 | 양쪽 담당 | 시한'), '**Open question (다음 QBR로)**' (bullets — 답 못 한 것 / 추가 데이터 필요), '**다음 QBR 시점**' (1줄), '**문의 / follow-up channel**' (1줄).\n\nQBR 미팅 노트:\n${text}`,
  translate_ko_to_udmurt: (text) =>
    `Translate the Korean text below into natural Udmurt (Удмурт кыл). Cyrillic script default. 격식 ('Тӥ' 정중 또는 복수 / 'тон' 친근) 원문에 맞춤. Reply with two sections: '**Берыктэм**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_pm_planning_doc_template_ko: (text) =>
    `Build a Korean PM annual planning doc template — written at year-start to align PM, Eng, Design, and leadership on annual product roadmap. Use 합쇼체. Markdown: '**한 줄 (다음 1년 핵심)**' (1줄 — '다음 1년 우리는 X에 집중'), '**왜 X에 집중 (1단락)**' (3-4줄 — 시장 / 사용자 / 회사 단계), '**전략적 베팅 (3개 — 각 h3 + 1단락)**' (베팅 정의 + 왜 vs 다른 옵션 + 성공 정의 + 위험), '**분기별 마일스톤 (테이블)**' ('Q1 | Q2 | Q3 | Q4' — 베팅별 마일스톤), '**우리가 하지 않을 것 (3 bullets)**' (명확 — 의도적으로 무시), '**메트릭 (목표)**' (테이블 — '메트릭 | 베이스라인 | 1년 후 목표'), '**자원 needs**' (bullets — Eng / Design / PM / 외주 / 도구), '**다른 팀 의존성**' (bullets), '**위험 (Top 3)**' (bullets), '**Revisit 시점**' (1줄 — '분기마다 OKR check + 6개월 재평가').\n\n제품 / 회사 컨텍스트:\n${text}`,
  translate_ko_to_mari_meadow: (text) =>
    `Translate the Korean text below into natural Meadow Mari (Олык марий йылме). Cyrillic script default. 격식 ('те' 정중 또는 복수 / 'тый' 친근) 원문에 맞춤. Reply with two sections: '**Кусарымаш**' and '**번역 노트**' (3 bullets in Korean — Meadow Mari is the larger of the two Mari languages).\n\n원문:\n${text}`,
  customer_first_workflow_setup_email_ko: (text) =>
    `Draft a Korean customer first workflow setup email — sent by CSM during onboarding when customer needs help setting up their first key workflow. Use 해요체. 친근 + 단계별 + 부담 없게. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] 첫 워크플로우 셋업 — 같이 해요'), '**본문**' (4 단락: 1) 1줄 — 본인 + 첫 셋업 부담 인정 + 같이 해줄 수 있다는 안심, 2) 우리가 본 그쪽의 첫 사용 case 1단락 — 어떤 워크플로우를 시도하고 있는지 우리 추측, 3) 두 가지 옵션 — A: 30분 화면 공유 (일정 후보 3개) / B: 비동기 — 우리가 만든 X 스텝 가이드 + 본인이 막히면 답장, 4) 다음 — 셋업 후 1주일 후 첫 사용 결과 같이 보기 약속), '**P.S.**' (1줄 — Slack 채널 공유 또는 본인 직접 연락 시간대).\n\n고객 / 사용 case 컨텍스트:\n${text}`,
  translate_ko_to_mari_hill: (text) =>
    `Translate the Korean text below into natural Hill Mari (Кырык мары йӹлмӹ). Cyrillic script default. 격식 ('тӓ' 정중 또는 복수 / 'тӹнь' 친근) 원문에 맞춤. Reply with two sections: '**Сӓрӹмӓш**' and '**번역 노트**' (3 bullets in Korean — Hill Mari is the smaller of the two Mari languages, distinct from Meadow Mari).\n\n원문:\n${text}`,
  internal_pm_strategy_offsite_outline_ko: (text) =>
    `Build a Korean PM team strategy offsite outline — 2-day in-person PM-only offsite, used to align on next-year strategy. Use 합쇼체. Markdown: '**Offsite 한 줄**' (1줄 — 시기 / 장소 / 핵심 목표 1개 — '다음 1년 PM 전략 정렬'), '**참석자**' (bullets — PM 이름 + 매니저 + 초청 (Eng Lead / Design Lead)), '**Pre-work (2주 전)**' (bullets — 시장 분석 / 사용자 데이터 / 작년 retro 읽기 / 본인 ideas 1페이지), '**Day 1: Diverge (테이블)**' ('시간 | 세션 | 진행 | 산출'): 시장 / 사용자 / 데이터 share + 가능한 옵션 brainstorm + 깊이 토론, '**Day 2: Converge (테이블)**' (Top 3 선택 + 구체화 + 다음 분기 1차 plan + 의식 정의 + commits), '**Decision-making 방식**' (1줄 — 'Head of Product 최종 결정 / 그 전에 합의 시도'), '**산출물**' (bullets — 1페이지 strategy doc / Q1 plan / 베팅 owner), '**Offsite 후 follow-up**' (bullets — 시한 + 누가 무엇).\n\nPM 팀 / 컨텍스트:\n${text}`,
  translate_ko_to_erzya: (text) =>
    `Translate the Korean text below into natural Erzya (Эрзянь кель). Cyrillic script default. 격식 ('тынь' 정중 또는 복수 / 'тон' 친근) 원문에 맞춤. Reply with two sections: '**Ютавтомась**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_proof_of_concept_summary_ko: (text) =>
    `Build a Korean customer Proof-of-Concept (PoC) summary doc — written at the end of a PoC by AE + Solutions Engineer, used to convert PoC to a contract. Use 합쇼체. 객관적 + 데이터 + 명확한 다음 단계. Markdown: '**PoC 한 줄 (성공 정의 + 결과)**' (1줄 — '[고객사] PoC: X 시도, Y 결과 — 우리 추천 Z'), '**원래 합의된 성공 기준 (테이블)**' ('기준 | 정의 | 측정 방법 | 결과 | 통과 여부'), '**PoC 기간 + 참여자**' (1줄), '**기술 검증 결과 (1단락)**' (3-4줄 — 통합 / 성능 / 보안 / scale), '**비즈니스 검증 결과 (1단락)**' (3-4줄 — 사용자 adoption / 시간 절약 / ROI 추정), '**관찰된 우려 / 갭 (bullets)**' (솔직 + 우리가 해결할 / 회피할 / 인정할), '**다음 단계 제안 — 옵션 3개**' (numbered — A: 즉시 paid 전환 + 가격 / B: 확장된 PoC X개월 / C: 우리에게 미스 fit, 솔직), '**우리 추천 + 이유**' (1단락), '**결정 시한 + 누가 결정**' (1줄).\n\nPoC / 결과 컨텍스트:\n${text}`,
  translate_ko_to_moksha: (text) =>
    `Translate the Korean text below into natural Moksha (Мокшень кяль). Cyrillic script default. 격식 ('тинь' 정중 또는 복수 / 'тон' 친근) 원문에 맞춤. Reply with two sections: '**Ютафтомась**' and '**번역 노트**' (3 bullets in Korean — Moksha is distinct from Erzya, both spoken by Mordvins).\n\n원문:\n${text}`,
  customer_strategic_account_summary_ko: (text) =>
    `Build a Korean 1-page strategic account summary — for our top-20 accounts, sent monthly to our Exec team. Use 합쇼체. 1 페이지 max. Markdown: '**고객 한 줄**' (이름 / 산업 / ARR / 계약 시작 / CSM / AE), '**health 신호등**' (1줄 — Green/Yellow/Red + 1줄 근거), '**핵심 메트릭 (테이블)**' ('지표 | 현재 | 변화 | benchmark'), '**최근 30일 활동**' (3 bullets — 미팅 / 출시 / 사고), '**열린 issue / 위험**' (bullets — Top 3), '**확장 / 기회**' (bullets), '**Exec sponsor 다음 액션**' (1줄 — Yes/No + 무엇), '**다음 30일 우리 priority**' (3 bullets), '**경쟁 위험 (있다면)**' (1줄), '**다음 QBR 시점**' (1줄).\n\n고객 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_karelian: (text) =>
    `Translate the Korean text below into natural Karelian (karjalan kieli). Latin script default (Cyrillic 가능). 격식 ('Työ' 정중 또는 복수 / 'sinä' 친근) 원문에 맞춤. Reply with two sections: '**Käännös**' and '**번역 노트**' (3 bullets in Korean — Karelian is closely related to Finnish).\n\n원문:\n${text}`,
  internal_pm_research_synthesis_template_ko: (text) =>
    `Build a Korean PM research synthesis template — used by PM team to summarize what they learned from a research project. Use 해요체. Markdown: '**한 줄 (가장 큰 발견)**' (1줄 — '우리가 배운 가장 큰 한 가지'), '**리서치 컨텍스트**' (1단락 — 무엇을 / 왜 / 누구를 / 어떻게), '**핵심 발견 (3-5개 — 각 h3 + 1단락)**' (각 발견 + 어떤 데이터가 뒷받침 + 직접 인용 1-2개), '**의외의 발견 (있다면)**' (1단락 — 가설과 다른 것), '**제품 결정에 미치는 영향 (테이블)**' ('발견 | 결정 / 액션 | 담당 PM | 시한'), '**이 리서치가 답하지 못한 것**' (bullets — 다음 리서치 idea), '**리서치 방법론 limitations**' (1단락 — 샘플 / 편향 / 일반화 한계), '**Raw 자료 위치**' (1줄 — 녹화 / 노트 / 코드북 링크 placeholder).\n\n리서치 raw 데이터:\n${text}`,
  translate_ko_to_veps: (text) =>
    `Translate the Korean text below into natural Veps (vepsän kel'). Latin script. 격식 ('teiš' 정중 또는 복수 / 'sinä' 친근) 원문에 맞춤. Reply with two sections: '**Kändlund**' and '**번역 노트**' (3 bullets in Korean — Veps is a small Finnic minority language).\n\n원문:\n${text}`,
  customer_upsell_proposal_doc_ko: (text) =>
    `Build a Korean customer upsell proposal doc — written by AE + CSM, sent to a customer proposing they expand to a higher tier / additional module. Use 합쇼체. 솔직 + 데이터 + 옵션. Markdown: '**한 줄 (제안)**' (1줄 — '[고객사], X에서 Y로 확장 제안'), '**왜 지금 (1단락)**' (3-4줄 — 사용 신호 / 사용자 요청 / 비즈니스 timing), '**그쪽이 얻는 것 (3 bullets)**' (구체적 가치 — 메트릭 가능하면), '**가격 + 옵션 (테이블)**' ('옵션 | 추가 비용 | 추가 기능 | 시작 가능 시점 | 권장 여부'), '**예상 ROI (수식)**' (1단락 — 'X 좌석 × Y / 월 = Z, 그쪽이 절약하는 시간 / 시간 시급 = W, ROI = (W - Z) / Z'), '**비슷한 회사 (Reference)**' (1단락 — 1-2 회사 + 결과 1줄), '**우려 처리 (테이블)**' ('예상 우려 | 우리 답변 1줄'), '**제안 일정**' (1줄 — 'X 일 안 결정 시 [시작 시점]'), '**다음 단계**' (1줄 — '30분 통화 일정 후보 3개').\n\n고객 / 사용 컨텍스트:\n${text}`,
  translate_ko_to_livonian: (text) =>
    `Translate the Korean text below into natural Livonian (līvõ kēļ) — extinct as a first language but revitalization efforts active. Latin script. 격식 ('tēg' 정중 또는 복수 / 'sinā' 친근) 원문에 맞춤. Reply with two sections: '**Tulkõjums**' and '**번역 노트**' (3 bullets in Korean — Livonian is highly endangered; mention this).\n\n원문:\n${text}`,
  internal_eng_team_capacity_calendar_ko: (text) =>
    `Build a Korean engineering team capacity calendar — visual representation of who's available when, for the next 90 days. Use 합쇼체. Markdown: '**한 줄 (이 캘린더 목적)**' (1줄 — '다음 90일 capacity 한눈에 보기 + planning 인풋'), '**팀 인원 + capacity baseline (테이블)**' ('이름 | 100% capacity (weeks/quarter) | 휴가 차감 | 마일스톤 차감 | 가용 weeks'), '**Calendar (월별 — 텍스트 시각화)**' (1단락 — '월 1주차 |||||| | 월 2주차 ||  | ...' 또는 markdown table per week), '**현재 commit 프로젝트 (테이블)**' ('프로젝트 | 인원 needs | 시작 | 끝 | overlap?'), '**Open slot (capacity 남는 영역)**' (bullets — 어떤 사람 / 언제 / 무엇 할 수 있나), '**Risk: over-commit 신호**' (1단락 — 누가 / 언제 / 어떤 영향), '**채용 / 자원 요청 (필요하면)**' (1줄), '**Calendar 업데이트 주기**' (1줄 — '매주 매니저가 업데이트').\n\n팀 / 분기 컨텍스트:\n${text}`,
  translate_ko_to_ingrian: (text) =>
    `Translate the Korean text below into natural Ingrian (ižoran keeli) — highly endangered Finnic language of Ingria. Latin script default. 격식 ('Tej' 정중 또는 복수 / 'sinä' 친근) 원문에 맞춤. Reply with two sections: '**Kääntöö**' and '**번역 노트**' (3 bullets in Korean — Ingrian is critically endangered; mention this).\n\n원문:\n${text}`,
  customer_renewal_pre_negotiation_doc_ko: (text) =>
    `Build a Korean internal customer renewal pre-negotiation doc — written by AE + CSM 60 days before renewal, prepares the team for negotiation strategy. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 현재 ARR / 갱신 만기), '**Health 신호**' (1줄 — Green/Yellow/Red + 1줄 근거), '**우리 목적**' (1줄 — '갱신 + X% 확장 / 갱신만 / save play / 회피'), '**우리 walk-away**' (1줄 — 'X 이하 / Y 조건 없으면 안 함'), '**우리 best case + 옵션 (테이블)**' ('옵션 | 가격 | 조건 | 보너스 | 우리 확률'), '**고객 측 우리에 대한 알려진 정보**' (bullets — 챔피언 / 사용 / 만족도 / 경쟁사 검토 신호), '**경쟁 위험 (있다면)**' (1단락), '**Negotiation 사다리 (테이블)**' ('단계 | 우리 양보 | 그쪽 commit'), '**미팅 일정 + 누가 인볼브**' (1단락), '**Exec sponsor escalation 트리거**' (1줄 — '언제 / 누구에게'), '**Save play (필요하면)**' (1단락 — at risk면 어떤 액션).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_yiddish: (text) =>
    `Translate the Korean text below into natural Yiddish (ייִדיש). Hebrew script default, RTL. 격식 ('איר' 정중 또는 복수 / 'דו' 친근) 원문에 맞춤. Reply with two sections: '**איבערזעצונג**' and '**번역 노트**' (3 bullets in Korean — Yiddish has German-influenced grammar with Hebrew loanwords).\n\n원문:\n${text}`,
  customer_implementation_30day_review_ko: (text) =>
    `Build a Korean customer implementation 30-day review doc — written by CSM after 30 days of customer onboarding, used to verify on-track for first value. Use 해요체. Markdown: '**한 줄 (D+30 상태)**' (1줄 — '[고객사] 구현 D+30 — on track / behind / at risk'), '**원래 30일 약속 vs 현재 (테이블)**' ('마일스톤 | 약속 | 실제 | Δ'), '**Time to first value (TTFV)**' (1줄 — '며칠 걸렸나, 우리 평균 vs 이번'), '**Adoption 신호 (bullets)**' (사용자 / 로그인 / 핵심 워크플로우 / 자율성), '**남은 위험 (bullets)**' (구체적), '**다음 30일 우선순위 (3 numbered)**' (구체적), '**우리가 다르게 했어야 한 것 (있다면 — 1 bullets)**' (솔직), '**그쪽이 다르게 했어야 한 것 (있다면 — 부드럽게)**' (1 bullets), '**Exec sponsor 노출?**' (1줄), '**다음 review 시점**' (1줄 — 'D+60').\n\n구현 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_ladino: (text) =>
    `Translate the Korean text below into natural Ladino (Judeo-Spanish — ג׳ודיאו-איספאנייול). Hebrew script (traditional) 또는 Latin script (modern) — Latin script default. 격식 ('vozotros' 정중 또는 복수 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Traduksion**' and '**번역 노트**' (3 bullets in Korean — Ladino is the Jewish diaspora language descended from medieval Spanish).\n\n원문:\n${text}`,
  internal_pm_research_intake_form_quick_ko: (text) =>
    `Build a Korean PM research intake form — short 1-page version for small / quick research requests. Use 합쇼체. Markdown: '**요청자 + 팀**' (1줄), '**제목 (요청 1줄)**' (1줄), '**왜 / 어떤 결정에 영향**' (2-3줄), '**Top 1 질문 (답을 받고 싶은 것)**' (1줄), '**대상 사용자 (1줄)**' (1줄), '**언제까지 필요 + 이유 (1줄)**' (1줄), '**우선순위 (1-5) + 1줄 이유**' (1줄), '**선호 산출물 (bullets)**' (slide / short doc / 영상 / 빠른 답변), '**자원 / 도움 가능**' (1줄 — '우리가 N명 모집 가능 / 데이터 X 추출').\n\n요청 컨텍스트:\n${text}`,
  translate_ko_to_judeo_arabic: (text) =>
    `Translate the Korean text below into natural Judeo-Arabic (יהודית-ערבית) — Hebrew script default, Arabic-based language used by Jewish communities in Arab lands. RTL. 격식 ('انتم' 정중 / 'انت' 친근) 원문에 맞춤. Reply with two sections: '**תרגום**' and '**번역 노트**' (3 bullets in Korean — note Judeo-Arabic has multiple regional variants).\n\n원문:\n${text}`,
  customer_health_save_play_ko: (text) =>
    `Build a Korean customer health save play — written by CSM when a customer has shown clear churn risk signals, defines the play to win them back. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 신호 / 갱신 만기), '**위험 신호 (Top 3)**' (bullets — 구체적 + 시점 + 데이터), '**우리 가설 — 진짜 이유 (1단락)**' (3-4줄 — 신호 해석 + 우리가 본 패턴), '**Save play (단계별, numbered)**' (각 단계: 'X일차 / 무엇 / 누가 / 산출물 / 측정'): '1) D+0 즉시 — Exec sponsor가 챔피언에게 직접 메일 / 2) D+3 — CSM + AE이 그쪽 Exec에게 미팅 요청 / 3) D+7 — 미팅에서 우리가 commit할 1-2개 / 4) D+14 — commit 진행 + 추가 가치 제공 / 5) D+30 — 다시 health check', '**Exec sponsor 인볼브 수준**' (1줄), '**다른 팀 도움 (Product / 디자인 / Eng 빠른 작업)**' (bullets — 가능하면), '**Save play 성공 정의**' (1줄 — 'X 까지 health Green 회복 / 갱신 commit'), '**Plan B (Save 실패 시)**' (1줄 — 'graceful churn 또는 winback로 전환').\n\n고객 / 신호 컨텍스트:\n${text}`,
  translate_ko_to_aramaic: (text) =>
    `Translate the Korean text below into natural Aramaic (ܐܪܡܝܐ) — choose Syriac or Modern Assyrian dialect based on context, Syriac script default. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ܬܘܪܓܡܐ**' and '**번역 노트**' (3 bullets in Korean — Aramaic has many variants, ancient and modern).\n\n원문:\n${text}`,
  internal_eng_arch_governance_doc_ko: (text) =>
    `Draft a Korean engineering architecture governance doc — defines how architectural decisions are made + reviewed. Use 합쇼체. Markdown: '**한 줄**' (1줄 — '우리는 X 방식으로 아키텍처 결정을 내림'), '**Scope (어떤 결정이 governance 대상)**' (bullets — 새 서비스 / 데이터 저장소 변경 / migration / 통합 등), '**Scope 외 (개인 / 팀이 자체 결정)**' (bullets — 명확히), '**RFC 프로세스 (단계 — numbered)**' ('초안 / 리뷰 / 결정 / 시행 / 사후 점검' 각 시한), '**검토자 / 결정자 (테이블)**' ('결정 종류 | 누가 리뷰 | 누가 결정 | 누가 영향'), '**Escalation 경로**' (1단락), '**자주 위반되는 가이드 + 우리 대응**' (bullets), '**Governance가 안 되는 경우 (slow / over-engineered)**' (1단락 — 우리가 어떻게 균형 잡나), '**Review 의식 (빈도 / 누가 / 어디)**' (1줄), '**문서 위치 / 결정 로그**' (1줄).\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_coptic: (text) =>
    `Translate the Korean text below into natural Coptic (ϯⲙⲉⲧⲣⲉⲙⲛ̀ⲭⲏⲙⲓ) — liturgical / revival language of Egyptian Christianity. Coptic script. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ⲡⲓⲉⲣⲙⲏⲛⲉⲩⲉⲓⲛ**' and '**번역 노트**' (3 bullets in Korean — note Coptic is primarily a liturgical language today).\n\n원문:\n${text}`,
  customer_implementation_60day_review_ko: (text) =>
    `Build a Korean customer implementation 60-day review doc — written by CSM at D+60 of customer onboarding, used to confirm second value milestone + identify expansion signals. Use 해요체. Markdown: '**한 줄 (D+60 상태)**' (1줄 — '[고객사] 구현 D+60 — milestone 2 달성? Y/N'), '**누적 vs 목표 (테이블)**' ('마일스톤 | D+30 | D+60 | D+90 목표 | 실제'), '**확장 신호 (bullets)**' (사용자 증가 / 새 use case / 다른 팀 관심 / 추가 모듈 요청), '**막힘 / 위험 (bullets)**' (남은 우려), '**다음 30일 우선순위 (3 numbered)**', '**Sales (AE) 인계 신호?**' (1줄 — Yes/No — expansion 기회면 yes), '**Exec sponsor 노출?**' (1줄), '**다음 review 시점**' (1줄 — 'D+90 = QBR').\n\n구현 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_circassian: (text) =>
    `Translate the Korean text below into natural Circassian (Адыгэбзэ — Adyghe / Kabardian). Cyrillic script default. 격식 ('фэ' 정중 또는 복수 / 'о' 친근) 원문에 맞춤. Reply with two sections: '**Зэдзэк1ыгъэ**' and '**번역 노트**' (3 bullets in Korean — Circassian comprises Adyghe and Kabardian, related but distinct).\n\n원문:\n${text}`,
  customer_quarterly_summary_email_ko: (text) =>
    `Draft a Korean quarterly summary email — sent by CSM to each major customer at the end of every quarter summarizing what we accomplished together. Use 해요체. 진심 + 데이터 + 다음 분기 약속. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] Q[N] 정리 — 우리 함께 한 것'), '**본문**' (4 단락: 1) 1-2줄 — 분기 함께 감사 + 1줄 — 가장 큰 함께 한 한 가지, 2) 메트릭 요약 1단락 — 'X 사용자 / Y 워크플로우 / Z 시간 절약 (추정)' — 구체적, 3) 우리 출시 중 그쪽에 가장 영향 준 1-2가지 — 1단락, 4) 다음 분기 — 우리 commit + 그쪽 priorities 같이 정렬할 30분 통화 일정 후보 3개), '**P.S.**' (1줄 — 솔직한 피드백 환영 / 익명 가능).\n\n고객 / 분기 데이터:\n${text}`,
  translate_ko_to_abkhaz: (text) =>
    `Translate the Korean text below into natural Abkhaz (аҧсуа бызшәа). Cyrillic script default. 격식 ('шәара' 정중 또는 복수 / 'уара/бара' 친근 — gender 차이 있음) 원문에 맞춤. Reply with two sections: '**Аиҭагара**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_pm_decision_template_ko: (text) =>
    `Build a Korean PM decision doc template — used when PM team needs to make a non-trivial product decision. Use 해요체. Markdown: '**Decision ID + 제목**' (1줄 — 'DEC-PRD-NNNN: 무엇'), '**한 줄 (TL;DR)**' (1줄 — 'X에서 Y로 변경 / X 안 만들기'), '**배경 (Why now)**' (1단락), '**옵션 (각 — h3 + Pros + Cons + 영향)**' (3-4개), '**우리 추천 + 이유**' (1단락), '**위험 (Top 3)**' (bullets), '**Reversibility**' (1줄 — Reversible / Hard to reverse), '**Open questions**' (bullets — 답을 받고 결정 가능한 것), '**리뷰어 + 결정자**' (1줄), '**시한**' (1줄), '**시행 후 측정 시점**' (1줄 — 'N주 후 X 메트릭 확인').\n\n결정 / 컨텍스트:\n${text}`,
  translate_ko_to_lak: (text) =>
    `Translate the Korean text below into natural Lak (Лакку маз). Cyrillic script default. 격식 ('зу' 정중 또는 복수 / 'ина' 친근) 원문에 맞춤. Reply with two sections: '**Бартдигу**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_implementation_90day_review_ko: (text) =>
    `Build a Korean customer implementation 90-day review doc — written by CSM at D+90 (보통 첫 QBR과 같이), summarizes onboarding + transitions to QBR cadence. Use 해요체. Markdown: '**한 줄 (D+90 상태)**' (1줄 — '구현 끝 / QBR cadence 시작'), '**원래 90일 약속 vs 결과 (테이블)**' (마일스톤 각, OK/지연/못함), '**TTFV (final)**' (1줄 — '며칠 / 우리 평균 vs 이번 / 학습'), '**Adoption 결과 (bullets)**' (사용자 / 워크플로우 / 활성도 / NPS), '**우리가 잘한 것 (3 bullets)**' (구체적), '**우리가 더 잘했어야 할 것 (2 bullets)**' (솔직), '**그쪽이 했어야 할 / 안 했던 것 (1-2 bullets — 부드럽게)**', '**다음 cadence**' (1단락 — QBR 빈도 / CSM 정기 / 미팅 형식), '**Exec 사인오프 + 만족도 점수**' (1줄).\n\n구현 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_dargin: (text) =>
    `Translate the Korean text below into natural Dargin (Дарган мез). Cyrillic script default. 격식 ('хӀуша' 정중 또는 복수 / 'хӀу' 친근) 원문에 맞춤. Reply with two sections: '**Хибдешуни**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_oncall_postmortem_doc_ko: (text) =>
    `Draft a Korean engineering on-call postmortem doc — written at the end of each on-call week / shift, summarizes patterns + improvements. Use 해요체. Markdown: '**한 줄 (이번 주)**' (1줄 — 'oncall 주 N건 / 미해결 X건 / 주목할 1가지'), '**Incident 요약 (테이블)**' ('INC-N | severity | 시간 | root cause 카테고리 | mitigation 시간'), '**알람 분석 (테이블)**' ('알람 | 횟수 | 실제 알람 (true positive) | noise (false positive)'), '**Noise 알람 (Top 3 — 우리가 다음에 줄일)**' (bullets), '**Runbook 갭 (이번 주 발견)**' (bullets — 무엇 / 어디에 추가할지), '**Capacity / 부담 신호 (1단락)**' (개인 / 팀 — burnout 신호 솔직), '**다음 oncall 권장 액션 (3 bullets)**' (numbered), '**팀 차원 액션 (postmortem 결과)**' (bullets — 누가 / 무엇 / 시한), '**다음 주 oncall에게**' (1단락 — 친근).\n\n주간 oncall raw 노트:\n${text}`,
  translate_ko_to_tabasaran: (text) =>
    `Translate the Korean text below into natural Tabasaran (Табасаран чӀал). Cyrillic script default. 격식 ('учвхьан' 정중 또는 복수 / 'уву' 친근) 원문에 맞춤. Reply with two sections: '**Таржума**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_success_metrics_dashboard_ko: (text) =>
    `Build a Korean customer success metrics dashboard doc — describes the metrics + dashboard structure for tracking customer success org-wide. Use 합쇼체. Markdown: '**한 줄 (대시보드 목적)**' (1줄 — 'CS 리더 + Exec이 매주 X 결정을 데이터로 빠르게'), '**핵심 메트릭 (테이블)**' ('메트릭 | 정의 | source | 임계값 (Green/Yellow/Red) | 시각화 형식 | owner'): GRR, NRR, Logo churn, Revenue churn, ARR by tier, CSM portfolio size, TTFV, Activation rate by D+30, Health score 분포, QBR completion rate, '**대시보드 레이아웃 (텍스트 wireframe)**' (1단락 — 상단 KPI / 좌측 health 분포 / 우측 churn trend / 하단 portfolio 분포), '**드릴다운 가능 영역**' (bullets — 어떤 메트릭에서 어떤 segment / cohort drill가능), '**알림 / Action 룰 (테이블)**' ('조건 | 알림 받는 사람 | 권장 액션'), '**업데이트 주기 (테이블)**' ('메트릭 | 데이터 갱신 빈도').\n\n시스템 / 메트릭 컨텍스트:\n${text}`,
  translate_ko_to_breton: (text) =>
    `Translate the Korean text below into natural Breton (Brezhoneg) — Celtic minority language of Brittany, France. 격식 ('c'hwi' 정중 / 'te' 친근) 원문에 맞춤. Reply with two sections: '**Troidigezh**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_quote_email_ko: (text) =>
    `Draft a Korean customer renewal quote email — sent by AE with formal renewal pricing options. Use 해요체. 명확 + 옵션 + 다음 단계. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] 갱신 견적 — [N개 옵션]'), '**본문**' (3 단락: 1) 1-2줄 — 1줄 안부 + 같이 정리한 갱신 옵션 보내드림, 2) 옵션 (테이블) — '플랜 | 좌석 | 기간 | 가격 | 추가 / 변경 사항' — 3-4가지 옵션 (현재 유지 / 확장 / 다년 / 작게), 3) 다음 단계 — 'X 까지 결정 / 30분 통화 일정 후보 3개 / 변경 요청 가능 항목'), '**P.S.**' (1줄 — 우리 결제 / 인보이스 / 청구 변경 처리 절차 안내).\n\n계약 / 갱신 컨텍스트:\n${text}`,
  translate_ko_to_cornish: (text) =>
    `Translate the Korean text below into natural Cornish (Kernewek) — Celtic minority language of Cornwall, UK. 격식 ('hwi' 정중 / 'ty' 친근) 원문에 맞춤. Reply with two sections: '**Treylyans**' and '**번역 노트**' (3 bullets in Korean — note Cornish is a revived language with limited everyday usage).\n\n원문:\n${text}`,
  internal_eng_alerting_strategy_doc_ko: (text) =>
    `Draft a Korean engineering alerting strategy doc — defines philosophy + standards for our alerting (Datadog / PagerDuty 등). Use 합쇼체. Markdown: '**한 줄 (우리 alert 신념)**' (1줄 — 'Alert는 사람을 깨우는 결정 — 사용자 영향이 명확할 때만'), '**Alert tiers (테이블)**' ('tier | 의미 | 응답 시한 | 페이지 받는 사람 | 예시'): P0 / P1 / P2 / Info-only, '**Alert 만드는 가이드라인 (bullets)**' (구체적 — 'X 행동이 가능한가 / 사용자 영향이 측정 가능한가 / N분 안 해결 가능한가'), '**자주 위반되는 패턴 (bullets)**' (구체적 + 우리 대응 — 'CPU > X% 알람 = noise, latency p99 > Y = OK'), '**Alert 정리 의식**' (1단락 — 주간 oncall postmortem에서 noise alert kill), '**Runbook 연결**' (1단락 — 각 alert는 runbook link 필수), '**Escalation 트리거 (테이블)**' ('상황 | 1차 | 2차 | exec'), '**Alert에 대한 학습**' (bullets — 어떤 새 alert가 좋은 신호인지 우리가 학습).\n\n팀 / 시스템 컨텍스트:\n${text}`,
  translate_ko_to_manx: (text) =>
    `Translate the Korean text below into natural Manx (Gaelg) — Celtic minority language of the Isle of Man. 격식 ('shiu' 정중 / 'oo' 친근) 원문에 맞춤. Reply with two sections: '**Çhyndaa**' and '**번역 노트**' (3 bullets in Korean — note Manx is a revived language).\n\n원문:\n${text}`,
  customer_advisory_quarterly_recap_ko: (text) =>
    `Draft a Korean Customer Advisory Board (CAB) quarterly recap — sent to all CAB members after a quarterly meeting summarizing what was discussed + what we'll do. Use 해요체. 진심 + 책임. Markdown: '**제목**' (1줄, 28자 이내 — 'CAB [분기] 정리 — 우리가 들은 것 + 할 것'), '**본문**' (4 단락: 1) 1-2줄 — 미팅 참여 감사 + 1줄 — 가장 큰 한 가지 깨달음, 2) 우리가 들은 핵심 테마 (3 bullets — 각 테마 + 누가 말함 — 익명 OK), 3) 우리가 할 commit — bullets — 단기 / 중기 / 장기 — 구체적 + 시한, 4) 다음 CAB 미팅 — 시점 + 다룰 토픽 + 사전 자료), '**P.S.**' (1줄 — 다음 미팅 사이 추가 의견 받는 channel + 본인 직접 연락).\n\nCAB 미팅 노트:\n${text}`,
  translate_ko_to_occitan: (text) =>
    `Translate the Korean text below into natural Occitan (occitan / lenga d'òc) — Romance language of southern France. 격식 ('vos' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Traduccion**' and '**번역 노트**' (3 bullets in Korean — note Occitan has multiple dialects, Languedoc as default).\n\n원문:\n${text}`,
  internal_design_review_protocol_ko: (text) =>
    `Draft a Korean internal design review protocol — defines how design reviews are run, who participates, what's reviewed. Use 해요체. Markdown: '**한 줄 (목적)**' (1줄 — '디자인 리뷰는 디자이너가 더 빨리 더 좋은 결정을 내리게 돕는 의식'), '**리뷰 대상 (bullets)**' (어떤 디자인이 review 대상 — 새 surface / 핵심 변경 / 사용자 노출 큰 것), '**리뷰 대상 X (bullets)**' (작은 수정 / 버그 fix 등은 X), '**참여자 (역할별)**' (테이블 — '필수 / 권장 / 옵션' — Designer / PM / Eng Lead / 다른 designer / Researcher), '**리뷰 단계 (numbered)**' ('Pre-read 24시간 전 / 15분 발표 / 25분 토론 / 5분 정리'), '**피드백 양식 (1단락)**' ('what works / what concerns / questions / suggestions' — Critique 방식 vs 평가 X), '**의사결정**' (1단락 — 'Designer 최종 결정 / PM이 우선순위 결정'), '**Follow-up**' (1줄 — '리뷰 후 X 까지 디자이너가 결정 doc 작성').\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_aromanian: (text) =>
    `Translate the Korean text below into natural Aromanian (armãneashti) — Romance minority language of the Balkans (Greece / Albania / North Macedonia / Romania). 격식 ('voi' 정중 또는 복수 / 'tini' 친근) 원문에 맞춤. Reply with two sections: '**Tradutsire**' and '**번역 노트**' (3 bullets in Korean — note Aromanian is closely related to Romanian).\n\n원문:\n${text}`,
  customer_data_retention_change_email_ko: (text) =>
    `Draft a Korean customer data retention change announcement email — sent to all customers when we change our data retention policy. Use 합쇼체. 명확 + 사용자 보호 강조. Markdown: '**제목**' (1줄, 28자 이내 — '데이터 보관 정책 변경 안내 — YYYY-MM-DD'), '**본문**' (4 단락: 1) 1-2줄 — 어떤 변경이 / 언제 시행 / 누구에게 영향 — 직설적, 2) 왜 변경하나 1단락 — 비즈 / 컴플라이언스 / 사용자 보호 — 솔직히, 3) 그쪽이 해야 할 것 (있다면 bullets — export / 명시적 동의 / 옵션 변경), 4) 영향 받지 않는 것 — 다른 정책 안 바뀜 / 데이터 보안 그대로), '**참고**' (1줄 — 자세한 정책 페이지 placeholder + DPO 연락처).\n\n변경 / 컨텍스트:\n${text}`,
  translate_ko_to_galician_variant: (text) =>
    `Translate the Korean text below into natural Galician (galego) — with attention to AGAL reintegrationist style if applicable. 격식 ('vostede' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Tradución**' and '**번역 노트**' (3 bullets in Korean — note Galician has multiple orthographic standards).\n\n원문:\n${text}`,
  customer_implementation_lessons_doc_ko: (text) =>
    `Build a Korean internal customer implementation lessons doc — written by CSM after a 90-day onboarding, captures what went well / not + transferable patterns for future onboardings. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 산업 / 계약 사이즈 / 시작 / 종료), '**구현 결과 한 줄**' (1줄 — '계획 대비 X 결과'), '**우리가 잘한 것 (3 bullets)**' (구체적 — 어떤 결정 / 어떤 행동), '**우리가 잘 안 한 것 (3 bullets)**' (솔직 — blame 없게), '**의외의 발견 (2 bullets)**' (예상과 다른 것), '**비슷한 고객 onboarding에 적용할 5가지 학습 (numbered)**' (구체적 — playbook 업데이트 권장), '**Resource / 도구 갭 (bullets)**' (우리가 부족해서 어렵게 한 것), '**다음 step (1줄)**' (1줄 — CSM이 다음 분기 어떻게 인계 / refresh).\n\n구현 / 회고 컨텍스트:\n${text}`,
  translate_ko_to_asturian: (text) =>
    `Translate the Korean text below into natural Asturian (asturianu) — Romance minority language of Asturias, Spain. 격식 ('vusté' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean — note Asturian shares some features with Galician and Castilian).\n\n원문:\n${text}`,
  internal_pm_eng_sprint_planning_ko: (text) =>
    `Build a Korean PM-Eng sprint planning template — used at the start of each 2-week sprint to align PM, Eng, Design. Use 해요체. Markdown: '**스프린트 한 줄 (이번 스프린트 목표)**' (1줄 — '이 2주 끝에 ~ 달성'), '**Sprint 컨텍스트 (1단락)**' (3-4줄 — 분기 OKR 어디 / 사용자 priorities / Eng capacity), '**Top priorities (3-5 — 테이블)**' ('항목 | 담당 | Eng 추정 | 완료 정의 | 의존성'), '**Stretch goals (있다면)**' (bullets), '**Bug + tech debt 할당**' (1줄 — '스프린트의 X% capacity'), '**Eng capacity 계산**' (테이블 — '이름 | 가용 days | 휴가 / 미팅 / 회의 차감 | 순수 dev days'), '**Risk + assumption**' (bullets — '~ 가정이 깨지면 priorities 재논의'), '**Sprint 의식**' (1줄 — '데일리 / 중간 demo / 끝 리뷰 + retro'), '**리뷰 demo 데이터**' (1줄 — '~ 시점 demo / 누가 참여').\n\nSprint / 팀 컨텍스트:\n${text}`,
  translate_ko_to_aragonese: (text) =>
    `Translate the Korean text below into natural Aragonese (aragonés) — Romance minority language of Aragon, Spain. 격식 ('vusté' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Traducción**' and '**번역 노트**' (3 bullets in Korean — note Aragonese is endangered).\n\n원문:\n${text}`,
  customer_renewal_handoff_email_ko: (text) =>
    `Draft a Korean customer renewal handoff email — sent when a CSM changes for a renewal customer right before / during renewal cycle. Use 해요체. 따뜻 + 인계 + 안심 + commit. Markdown: '**제목**' (1줄, 26자 이내 — '안녕하세요 [이름] — 갱신 함께해드릴게요'), '**본문**' (4 단락: 1) 1-2줄 — 본인 + 전임 CSM [전임자] 잘 정리해 줘서 감사, 2) 그쪽에 대해 이미 아는 것 — 1단락 — 회사 / 사용 / 우리와의 history — 빠른 학습 보임, 3) 갱신 사이클 = 우리 다음 30-60일 우선순위 — '본인이 직접 책임지고 갱신 진행 + 그쪽 우려 빠르게 도울 것', 4) 첫 만남 — 30분 통화 일정 후보 3개), '**P.S.**' (1줄 — 본인 직접 연락 채널 + 응답 SLA).\n\n전임 + 고객 컨텍스트:\n${text}`,
  translate_ko_to_leonese: (text) =>
    `Translate the Korean text below into natural Leonese (llionés) — Romance minority language of León, Spain. 격식 ('vusté' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Tradución**' and '**번역 노트**' (3 bullets in Korean — note Leonese is endangered, closely related to Asturian).\n\n원문:\n${text}`,
  internal_eng_release_train_doc_ko: (text) =>
    `Draft a Korean engineering release train doc — defines our release cadence + how teams ship. Use 합쇼체. Markdown: '**한 줄 (우리 release 신념)**' (1줄 — '작게 자주 release > 크게 가끔'), '**Cadence (테이블)**' ('환경 | 빈도 | 자동화 수준 | 누가 trigger'): prod / staging / preview, '**Train schedule**' (1단락 — '매일 N회 / 주요 release window / freeze 시점'), '**누가 release 권한 (bullets)**' (Eng / SRE / EM), '**Release checklist (numbered)**' (배포 전 / 중 / 후 — 'tests OK / monitoring 준비 / runbook / rollback plan / changelog'), '**Rollback 가이드**' (1단락 — '< X분 안 rollback / 누가 결정 / 어떻게'), '**Release 후 모니터링 (bullets)**' (메트릭 / 시한 / 누가 watching), '**비상 release (hotfix)**' (1단락 — 일반 train 외 권한 / 절차 / 시한), '**Release tooling**' (bullets — CI / CD / Feature flags / 모니터링).\n\n팀 / 시스템 컨텍스트:\n${text}`,
  translate_ko_to_extremaduran: (text) =>
    `Translate the Korean text below into natural Extremaduran (estremeñu) — Romance minority language of Extremadura, Spain. 격식 ('vusté' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Trairucción**' and '**번역 노트**' (3 bullets in Korean — note Extremaduran is endangered).\n\n원문:\n${text}`,
  customer_implementation_lessons_external_blog_ko: (text) =>
    `Build a Korean external blog post about lessons from customer implementations — written by Head of CS / CEO, shares public-friendly lessons we learned from helping customers onboard. Use 해요체. 진정성 + 사용자 도움 + brand humility. Markdown: '**제목**' (1줄, 32자 이내 — '우리가 [N] 고객 onboarding에서 배운 [N]가지'), '**Hook (1단락)**' (3-4줄 — 가장 의외 / 흥미로운 1가지로 시작), '**Lesson별 (각 h3 + 1단락 + 데이터 / 사례 — 익명 OK)**' (5-7개): 'X 가정은 틀렸다' / 'Y 단계가 더 중요했다' / 'Z 도구가 의외로 핵심' / 등, '**가장 자주 본 실수 (2 bullets)**' (우리 측 인정), '**다음 — 우리가 우리 onboarding을 어떻게 바꾸나 (3 bullets)**' (구체적 commit), '**Closing 1단락**' (3-4줄 — 사용자 신뢰 + 다음에 더 잘하겠다는 약속), '**CTA (1줄)**' (직접 onboarding 경험 share할 채널 또는 데모 신청).\n\n학습 / 사례 raw:\n${text}`,
  translate_ko_to_sardinian: (text) =>
    `Translate the Korean text below into natural Sardinian (sardu) — Romance language of Sardinia, Italy. 격식 ('bois' 정중 / 'tue' 친근) 원문에 맞춤. Reply with two sections: '**Tradutzione**' and '**번역 노트**' (3 bullets in Korean — note Sardinian has multiple variants, Logudorese/Campidanese).\n\n원문:\n${text}`,
  customer_renewal_thank_you_call_script_ko: (text) =>
    `Draft a Korean customer renewal thank-you call script — short 15-min call after renewal signing. Use 해요체. 진심 + 다음 단계. Markdown: '**Opening (2분)**' (1단락 — 진심 어린 감사 + 1줄 — 함께한 시간 의미), '**가치 회상 (3분)**' (1단락 — 우리가 본 그쪽 가장 큰 성과 1-2개 — 데이터), '**다음 분기 정렬 (5분)**' (numbered open question 3개 — '다음 분기 우선순위 / 우리가 더 도울 것 / 새로 시도하고 싶은 것'), '**우리 commit (3분)**' (1단락 — 다음 분기 우리가 할 1-2가지), '**Close (2분)**' (1단락 — 다음 QBR 일정 + 본인 연락 채널 + 솔직 피드백 환영), '**Follow-up email 시한**' (1줄 — '24시간 안').\n\n고객 / 갱신 컨텍스트:\n${text}`,
  translate_ko_to_corsican: (text) =>
    `Translate the Korean text below into natural Corsican (corsu) — Romance language of Corsica, France. 격식 ('voi' 정중 / 'tù' 친근) 원문에 맞춤. Reply with two sections: '**Traduzzione**' and '**번역 노트**' (3 bullets in Korean — note Corsican is closely related to Italian dialects).\n\n원문:\n${text}`,
  internal_eng_tech_debt_register_ko: (text) =>
    `Build a Korean engineering tech debt register — a living doc tracking known tech debt + prioritization. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄 — '알려진 tech debt를 가시화 + 분기마다 일부 갚기'), '**Debt 항목 (테이블)**' ('ID | 영역 | 설명 1줄 | 영향 (속도/위험/비용) | 크기 추정 | 우선순위 | owner'), '**우선순위 기준 (1단락)**' ('영향 × 빈도 / 크기 — 자주 막히고 빨리 고치면 high'), '**이번 분기 갚기로 한 것 (테이블)**' ('항목 | 왜 지금 | 추정 | 담당'), '**의도적으로 유지하는 debt (1단락 + bullets)**' ('지금 안 갚는 이유 — 영향 작음 / 곧 deprecate / 비용 too high'), '**새 debt 추가 가이드**' (bullets — 언제 / 어떻게 등록), '**Review 주기**' (1줄 — '분기마다 register 정리 + 20% capacity 할당').\n\n시스템 / debt 컨텍스트:\n${text}`,
  translate_ko_to_friulian: (text) =>
    `Translate the Korean text below into natural Friulian (furlan) — Rhaeto-Romance language of northeastern Italy. 격식 ('vô' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Traduzion**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  customer_renewal_lost_winback_plan_ko: (text) =>
    `Build a Korean customer renewal-lost winback plan — written after a customer churns at renewal, defines the 6-month winback strategy. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 잃은 시점 / 잃은 ARR / 잃은 이유 1줄), '**Winback 가능성 (1줄)**' (High / Medium / Low + 이유), '**떠난 진짜 이유 + 그 이유가 변할 수 있는지 (1단락)**' (가격 → 우리 가격 변경? / 기능 → 우리 로드맵? / 챔피언 이직 → 새 챔피언?), '**Winback timeline (단계별 numbered)**' (각 'X개월차 / 무엇 / 누가 / 트리거'): '1) D+0 graceful exit + 문 열어둠 / 2) D+30 가벼운 가치 contents share / 3) D+90 우리가 그 이유 해결한 update / 4) D+180 winback 제안 + 인센티브', '**Trigger 신호 (우리가 노릴)**' (bullets — 그쪽 회사 재성장 / 경쟁사 가격 인상 / 챔피언 복귀), '**Winback 인센티브 옵션**' (bullets — 'X% / 무료 migration / 우선 onboarding'), '**책임자 + 다음 액션 시점**' (1줄).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_ladin: (text) =>
    `Translate the Korean text below into natural Ladin (ladin) — Rhaeto-Romance language of the Dolomites, northern Italy. 격식 ('vos' 정중 / 'tu' 친근) 원문에 맞춤. Reply with two sections: '**Tradleta**' and '**번역 노트**' (3 bullets in Korean — note Ladin is distinct from Latin and Swiss Romansh, has multiple valley variants).\n\n원문:\n${text}`,
  internal_pm_feature_prioritization_ko: (text) =>
    `Build a Korean PM feature prioritization framework doc — defines how the PM team decides what to build next. Use 합쇼체. Markdown: '**한 줄 (우리 신념)**' (1줄 — '우리는 X 기준으로 우선순위를 정함'), '**프레임워크 (RICE 또는 우리 변형)**' (1단락 — 'Reach × Impact × Confidence / Effort' 또는 우리 정의 + 각 점수 의미), '**점수 가이드 (테이블)**' ('차원 | 1점 | 3점 | 5점 — 구체적 정의'), '**Scoring 예시 (테이블)**' ('기능 | Reach | Impact | Confidence | Effort | Score'), '**프레임워크가 안 잡는 것 (1단락)**' ('전략적 베팅 / 기술 부채 / 컴플라이언스 — 별도 처리'), '**우선순위 회의 (의식)**' (1줄 — 빈도 / 누가 / 산출), '**Tie-breaker (1단락)**' ('점수 비슷하면 — 전략 정렬 / 빠른 학습 / 사용자 목소리'), '**Revisit (1줄)**' ('분기마다 + 큰 데이터 변화 시').\n\n제품 / 컨텍스트:\n${text}`,
  translate_ko_to_romansh_sursilvan: (text) =>
    `Translate the Korean text below into natural Romansh — Sursilvan variant (sursilvan) — one of the five Romansh dialects of Switzerland's Grisons. 격식 ('Vus' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Translaziun (Sursilvan)**' and '**번역 노트**' (3 bullets in Korean — note this is a specific Romansh variant, distinct from standardized Rumantsch Grischun).\n\n원문:\n${text}`,
  customer_qbr_deck_outline_detailed_ko: (text) =>
    `Build a Korean detailed QBR (Quarterly Business Review) deck outline — slide-by-slide for a customer QBR presentation. Use 합쇼체. Markdown: '**QBR 한 줄 (목표)**' (1줄 — '이번 QBR로 X 달성'), '**슬라이드별 (각 — h3 슬라이드 제목 + 내용 bullets + 발표 노트 1줄)**': 1) Cover (회사 / 분기 / 참석자), 2) Agenda + 목표, 3) 지난 분기 우리 commit recap (했나 안 했나), 4) 그쪽 사용 데이터 (메트릭 + trend), 5) 가치 실현 (ROI / 성과 / 인용), 6) 잘 안 된 것 (솔직), 7) 우리 로드맵 미리보기 (그쪽에 영향 큰 것 — NDA), 8) 다음 분기 같이 할 3가지, 9) 확장 / 기회 (있다면), 10) Open discussion / Q&A, 11) 다음 단계 + 액션 + 다음 QBR 일정, '**발표 가이드 (1단락)**' (시간 분배 / 누가 어떤 슬라이드 / 듣기 vs 말하기 비율), '**Pre-read (1줄)**' (24시간 전 보낼 것).\n\n고객 / 분기 컨텍스트:\n${text}`,
  translate_ko_to_romansh_vallader: (text) =>
    `Translate the Korean text below into natural Romansh — Vallader variant (vallader) — one of the five Romansh dialects, spoken in the Lower Engadine, Switzerland. 격식 ('Vus' 정중 / 'tü' 친근) 원문에 맞춤. Reply with two sections: '**Translaziun (Vallader)**' and '**번역 노트**' (3 bullets in Korean — note this is a specific Engadine Romansh variant).\n\n원문:\n${text}`,
  customer_renewal_save_email_ko: (text) =>
    `Draft a Korean customer renewal save email — sent during an active save play when a customer is leaning toward not renewing. Use 해요체. 진심 + 인정 + 구체적 제안 + 무겁지 않게. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] — 떠나기 전 5분만'), '**본문**' (4 단락: 1) 1-2줄 — 갱신 안 할 수도 있다는 신호 본 것 + 우리가 진심으로 그쪽을 지키고 싶다는 1줄, 2) 우리가 부족했던 것 인정 — 구체적, 회피 X, 3) 우리가 즉시 할 수 있는 것 — bullets — '가격 / 기능 / 지원 / Exec sponsor 직접 인볼브' — 구체적 + commit, 4) 짧은 다음 단계 — '30분 통화로 솔직히 이야기 / 그래도 떠나기로 하면 깔끔하게 도울 것'), '**P.S.**' (1줄 — Exec sponsor도 직접 통화 가능).\n\n고객 / 신호 컨텍스트:\n${text}`,
  translate_ko_to_romansh_puter: (text) =>
    `Translate the Korean text below into natural Romansh — Puter variant (puter) — one of the five Romansh dialects, spoken in the Upper Engadine, Switzerland. 격식 ('Vus' 정중 / 'tü' 친근) 원문에 맞춤. Reply with two sections: '**Translaziun (Puter)**' and '**번역 노트**' (3 bullets in Korean — note Puter is the Upper Engadine Romansh variant).\n\n원문:\n${text}`,
  internal_eng_incident_severity_doc_ko: (text) =>
    `Draft a Korean engineering incident severity definition doc — defines SEV levels + response expectations. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄 — '모두가 사고 심각도를 같은 기준으로 판단하게'), '**Severity levels (테이블)**' ('SEV | 정의 | 사용자 영향 | 응답 시한 | 누가 페이지 | 예시'): SEV-1 (전체 다운 / 데이터 손실), SEV-2 (핵심 기능 일부), SEV-3 (성능 저하 / 일부 사용자), SEV-4 (사소), '**누가 SEV 결정 (1줄)**' (initial caller가 추정 → IC가 확정), '**각 SEV 응답 의무 (테이블)**' ('SEV | 내부 comms | 외부 comms | postmortem 필수? | exec 알림'), '**SEV 올리기 / 내리기 (1단락)**' (언제 / 누가 / 어떻게), '**Comms 템플릿 위치**' (1줄), '**자주 헷갈리는 경우 (3 bullets)**' (각 추천 SEV + 이유).\n\n팀 / 시스템 컨텍스트:\n${text}`,
  translate_ko_to_romansh_surmiran: (text) =>
    `Translate the Korean text below into natural Romansh — Surmiran variant (surmiran) — one of the five Romansh dialects, spoken in central Grisons, Switzerland. 격식 ('Vus' 정중 / 'te' 친근) 원문에 맞춤. Reply with two sections: '**Translaziun (Surmiran)**' and '**번역 노트**' (3 bullets in Korean — note Surmiran is the central Grisons Romansh variant).\n\n원문:\n${text}`,
  customer_quarterly_value_report_ko: (text) =>
    `Build a Korean customer quarterly value report — a polished data report sent to a customer summarizing the ROI/value we delivered. Use 합쇼체. Markdown: '**Cover 한 줄**' (회사 / 분기 / 작성자), '**Executive summary (1단락)**' (3-4줄 — 가장 큰 가치 1-2개 + 숫자), '**핵심 메트릭 (테이블)**' ('지표 | 분기초 | 분기말 | Δ | 의미'), '**시간 / 비용 절약 (수식 + 1단락)**' (구체적 계산 — 'X 워크플로우 자동화 = Y 시간 / 주 = Z 시간 / 분기 = 약 W원'), '**adoption 성장 (1단락 + 데이터)**' (사용자 / 워크플로우 / 팀 확산), '**주요 마일스톤 (bullets)**' (이번 분기 함께 달성), '**우리가 출시한 것 중 그쪽에 영향 준 것 (bullets)**', '**다음 분기 추천 (3 bullets)**' (그쪽 가치 더 키울 액션), '**부록**' (bullets — 메서드 / 데이터 출처).\n\n고객 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_romansh_sutsilvan: (text) =>
    `Translate the Korean text below into natural Romansh — Sutsilvan variant (sutsilvan) — one of the five Romansh dialects, spoken in the Hinterrhein valley, Switzerland (smallest variant). 격식 ('Vus' 정중 / 'tei' 친근) 원문에 맞춤. Reply with two sections: '**Translaziun (Sutsilvan)**' and '**번역 노트**' (3 bullets in Korean — note Sutsilvan is the smallest Romansh variant).\n\n원문:\n${text}`,
  internal_pm_user_feedback_triage_ko: (text) =>
    `Draft a Korean PM user feedback triage process doc — defines how incoming user feedback (support / sales / NPS / social) is collected, categorized, and acted on. Use 해요체. Markdown: '**한 줄 (목적)**' (1줄 — '사용자 피드백이 사라지지 않고 결정에 닿게'), '**Feedback source (테이블)**' ('source | 누가 모음 | 어디로 흘러감 | 빈도'): 지원 티켓 / 영업 통화 / NPS / 소셜 / CAB / 사용자 인터뷰, '**Triage 단계 (numbered)**' ('1) 모든 피드백을 X에 모음 / 2) 주간 PM이 카테고리 분류 / 3) 빈도 + 영향 점수 / 4) 백로그 연결 또는 reject 이유 기록'), '**카테고리 (bullets)**' (버그 / 기능 요청 / UX 마찰 / 문서 / 가격 / 기타), '**우선순위 연결 (1단락)**' (triage → prioritization 프레임워크 연결), '**Loop 닫기 (1단락)**' ('피드백 준 사용자에게 어떻게 / 언제 답하나'), '**Review 의식**' (1줄 — '매주 triage / 매월 trend 리뷰'), '**Owner (1줄)**'.\n\n제품 / 컨텍스트:\n${text}`,
  translate_ko_to_griko: (text) =>
    `Translate the Korean text below into natural Griko (Γκρίκο / grico) — endangered Italo-Greek dialect of southern Italy (Salento / Calabria). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Metàfrasi**' and '**번역 노트**' (3 bullets in Korean — note Griko is a critically endangered Greek dialect spoken in Italy).\n\n원문:\n${text}`,
  customer_expansion_business_case_ko: (text) =>
    `Build a Korean customer expansion business case — written by AE + CSM, an internal doc justifying investment in expanding a specific account. Use 합쇼체. Markdown: '**한 줄 (기회)**' (1줄 — '[고객사] X → Y 확장, 추정 +Z ARR'), '**현재 상태**' (1줄 — 현재 ARR / 좌석 / 모듈 / health), '**확장 가설 (1단락)**' (3-4줄 — 왜 그쪽이 확장할 가능성 + 어떤 신호), '**확장 시나리오 (테이블)**' ('시나리오 | 추가 ARR | 확률 | 필요한 투자 (우리 시간/리소스)'), '**확장을 막는 것 (blockers)**' (bullets — 예산 / 챔피언 / 기능 갭 / 경쟁), '**투자 요청 (1단락)**' ('우리가 무엇을 투입해야 하나 — Solutions Engineer 시간 / Exec sponsor / 커스텀 작업'), '**예상 ROI (수식)**' (1단락 — '투자 X시간/원 대비 추정 +Y ARR'), '**Timeline (numbered)**' (단계별 + 시한), '**추천 (Go / No-go / Wait)**' (1줄 + 근거).\n\n고객 / 확장 컨텍스트:\n${text}`,
  translate_ko_to_griko_calabrian: (text) =>
    `Translate the Korean text below into natural Calabrian Greek (Greco-Bovesio / Greko of Calabria) — endangered Italo-Greek variety distinct from Salentino Griko. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Metàfrasi (Greko)**' and '**번역 노트**' (3 bullets in Korean — note this is the Calabrian variety of Italo-Greek, critically endangered).\n\n원문:\n${text}`,
  customer_health_qbr_combined_doc_ko: (text) =>
    `Build a Korean combined customer health + QBR doc — single doc used both internally (health view) and as the QBR basis. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / ARR / 계약 / health 신호등), '**[내부] Health 요약 (1단락)**' (CSM 관점 — 위험 / 기회 / 다음 액션), '**[내부] 메트릭 + 위험 (테이블)**' ('메트릭 | 현재 | trend | 위험 신호'), '**[QBR용] Executive summary (1단락)**' (고객에게 보여줄 — 가치 중심), '**[QBR용] 가치 실현 (테이블 + 1단락)**' (ROI / 성과 / 인용), '**[QBR용] 다음 분기 같이 할 3가지**' (numbered), '**[내부] 확장 / 갱신 신호**' (bullets — QBR에서 직접 안 보여줌), '**[내부] 경쟁 위험**' (1줄), '**[양쪽] 액션 + 시한 (테이블)**' ('항목 | 담당 | 시한'), '**다음 QBR 시점**' (1줄). (내부 vs QBR 섹션 명확히 구분).\n\n고객 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_arberesh: (text) =>
    `Translate the Korean text below into natural Arbëresh (arbërisht) — Italo-Albanian language spoken by the Arbëreshë communities of southern Italy. 격식 ('ju' 정중 / 'ti' 친근) 원문에 맞춤. Reply with two sections: '**Përkthimi (Arbërisht)**' and '**번역 노트**' (3 bullets in Korean — note Arbëresh is an old Albanian variety preserved in Italy, distinct from modern Albanian).\n\n원문:\n${text}`,
  internal_eng_slo_definition_doc_ko: (text) =>
    `Draft a Korean engineering SLO (Service Level Objective) definition doc — defines our SLOs + error budgets for a service. Use 합쇼체. Markdown: '**서비스 한 줄**' (1줄 — 어떤 서비스 / 누가 owner), '**왜 SLO (1단락)**' (2-3줄 — 신뢰성과 속도의 균형 / 사용자 기대), '**SLI (Service Level Indicators — 테이블)**' ('SLI | 정의 | 측정 방법 | source'): availability / latency p99 / error rate / 등, '**SLO 목표 (테이블)**' ('SLI | SLO 목표 | 측정 기간 | 근거'), '**Error budget (1단락 + 수식)**' ('99.9% SLO = 월 43분 다운 허용 = error budget'), '**Error budget 정책 (1단락)**' ('budget 소진 시 — feature freeze / 신뢰성 우선'), '**알림 연결 (1줄)**' (SLO 위반 임박 시 alert), '**Review 주기 (1줄)**' ('분기마다 SLO 재평가'), '**Stakeholder (1줄)**'.\n\n서비스 / 컨텍스트:\n${text}`,
  translate_ko_to_cimbrian: (text) =>
    `Translate the Korean text below into natural Cimbrian (Zimbrisch / cimbro) — endangered Germanic language of northeastern Italy (Veneto / Trentino). 격식 ('iar' 정중 / 'du' 친근) 원문에 맞춤. Reply with two sections: '**Übersetzung (Zimbrisch)**' and '**번역 노트**' (3 bullets in Korean — note Cimbrian is a highly endangered Germanic island language in Italy).\n\n원문:\n${text}`,
  customer_renewal_multi_year_proposal_ko: (text) =>
    `Build a Korean multi-year renewal proposal doc — sent to a customer proposing a 2-3 year commitment with incentives. Use 합쇼체. Markdown: '**한 줄 (제안)**' (1줄 — '[고객사] 다년 계약 제안 — N년, X% 할인'), '**왜 다년 (양쪽 win — 테이블)**' ('항목 | 그쪽 win | 우리 win'), '**옵션 (테이블)**' ('기간 | 연 가격 | 총액 | 할인 | 락인 조건 | 추가 가치'): 1년 / 2년 / 3년, '**다년의 가치 (그쪽 관점 — bullets)**' (가격 예측성 / 우선 지원 / 락인 가격 / 우선 로드맵 영향), '**우려 처리 (테이블)**' ('우려 (벤더 락인 / 유연성) | 우리 답변 — 중도 해지 / 다운그레이드 조항'), '**다년 락인의 리스크 (그쪽에게 솔직히)**' (1단락 — 우리가 솔직히 인정), '**제안 일정**' (1줄), '**다음 단계**' (1줄 — '30분 통화 + Exec sponsor 동석').\n\n고객 / 계약 컨텍스트:\n${text}`,
  translate_ko_to_mocheno: (text) =>
    `Translate the Korean text below into natural Mòcheno (bersntolerisch) — endangered Germanic language of the Fersina valley, Trentino, Italy. 격식 ('ir' 정중 / 'du' 친근) 원문에 맞춤. Reply with two sections: '**Übersetzung (Mòcheno)**' and '**번역 노트**' (3 bullets in Korean — note Mòcheno is a critically endangered Germanic island language in Italy).\n\n원문:\n${text}`,
  internal_pm_metric_definition_doc_ko: (text) =>
    `Build a Korean PM product metric definition doc — defines our core product metrics (North Star + supporting) so the whole company aligns. Use 합쇼체. Markdown: '**한 줄 (North Star)**' (1줄 — '우리 North Star metric은 X'), '**North Star 정의 (1단락 + 수식)**' (정확한 계산 + 왜 이게 핵심 가치를 반영), '**Supporting metrics (테이블)**' ('메트릭 | 정의 | North Star와 관계 | owner | 측정 주기'): activation / retention / engagement / referral / 등, '**메트릭별 정확한 정의 (각 h3)**' (포함 / 제외 / edge case — '활성 사용자 = 7일 내 X 액션, 단 admin/봇 제외'), '**측정 인프라 (1줄)**' (어디서 데이터 / 누가 신뢰 보증), '**자주 헷갈리는 것 (bullets)**' ('vanity metric vs actionable'), '**Review 주기 (1줄)**' ('분기마다 North Star 재검토').\n\n제품 / 컨텍스트:\n${text}`,
  translate_ko_to_walser: (text) =>
    `Translate the Korean text below into natural Walser German (Walserdeutsch / Walsertitsch) — Alemannic German variety of Walser communities in the Alps (Switzerland / Italy / Liechtenstein / Austria). 격식 ('Ier' 정중 / 'du' 친근) 원문에 맞춤. Reply with two sections: '**Übersetzig (Walsertitsch)**' and '**번역 노트**' (3 bullets in Korean — note Walser is an Alpine Alemannic variety, distinct from standard Swiss German).\n\n원문:\n${text}`,
  customer_executive_business_review_agenda_ko: (text) =>
    `Build a Korean Executive Business Review (EBR) agenda — annual exec-level strategic review for top accounts (deeper than QBR). Use 합쇼체. Markdown: '**EBR 한 줄 (목표)**' (1줄 — '연간 전략 정렬 + 다년 관계 강화'), '**참석자 (양쪽 exec — 테이블)**', '**Pre-work (1주 전)**' (bullets — 우리가 보낼 자료 / 그쪽에 받을 인풋), '**Agenda (90분 — 테이블)**' ('시간 | 세션 | 진행 | 산출'): '10분 환영 + 양쪽 exec 정렬 / 15분 연간 가치 회고 (데이터) / 15분 그쪽 회사 전략 + 우리 연결 (그쪽이 말함) / 15분 우리 비전 + 로드맵 (NDA) / 15분 다년 / 전략 파트너십 논의 / 15분 양쪽 commit + 결정 / 5분 다음 단계', '**우리 목적 (1줄)**' (갱신 + 전략 파트너 + Exec 관계), '**우리가 commit 가능한 것 (Exec ready — bullets)**', '**받고 싶은 정보 (1-2 bullets)**', '**Follow-up 시한**' (1줄).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_gagauz: (text) =>
    `Translate the Korean text below into natural Gagauz (Gagauz dili) — Turkic language of Moldova (Gagauzia). Latin script default. 격식 ('siz' 정중 또는 복수 / 'sän' 친근) 원문에 맞춤. Reply with two sections: '**Çevirmäk**' and '**번역 노트**' (3 bullets in Korean — note Gagauz is a Turkic language with Orthodox Christian heritage).\n\n원문:\n${text}`,
  customer_renewal_executive_email_ko: (text) =>
    `Draft a Korean exec-to-exec renewal email — sent by our CEO / VP to the customer's exec sponsor near renewal. Use 합쇼체. 짧 + 존중 + 전략 + commit. Markdown: '**제목**' (1줄, 28자 이내 — '[고객사] 갱신 — 직접 인사드립니다'), '**본문**' (3 단락: 1) 1-2줄 — 직접 연락 이유 + 함께한 시간 의미 한 줄, 2) 우리가 본 그쪽 회사의 가치 1단락 — 전략적 + 데이터 (자랑 X) + 우리가 다음 N년 함께하고 싶은 진심, 3) 다음 — '갱신 진행 + 30분 exec 통화로 전략 정렬 / 우리 Exec sponsor가 직접 곁에' + 일정 후보 2-3개), '**서명**' (CEO / VP + 직접 휴대전화).\n\n고객 / 갱신 컨텍스트:\n${text}`,
  translate_ko_to_crimean_tatar: (text) =>
    `Translate the Korean text below into natural Crimean Tatar (Qırımtatar tili). Latin script default (Cyrillic 가능). 격식 ('siz' 정중 또는 복수 / 'sen' 친근) 원문에 맞춤. Reply with two sections: '**Tercime**' and '**번역 노트**' (3 bullets in Korean).\n\n원문:\n${text}`,
  internal_eng_capacity_quarterly_review_ko: (text) =>
    `Build a Korean engineering capacity quarterly review doc — looks back at how the team's capacity was actually spent vs planned. Use 합쇼체. Markdown: '**한 줄 (이번 분기)**' (1줄 — '계획 대비 실제 capacity 사용 X% 일치'), '**계획 vs 실제 (테이블)**' ('카테고리 | 계획 weeks | 실제 weeks | Δ | 이유'): 신규 기능 / 버그 / 테크부채 / 인시던트 / 회의 / 기타, '**가장 큰 차이 분석 (3 bullets)**' (각 — 무엇이 예상보다 많이 / 적게 + 왜), '**인시던트 / 운영 부담 (1단락)**' (예상 X vs 실제 Y, 패턴), '**번아웃 / 부담 신호 (1단락)**' (솔직 — 누가 / 어떤 영역 과부하), '**다음 분기 capacity 조정 (3 bullets)**' (numbered — buffer / 채용 / 위탁), '**Planning 정확도 개선 (1단락)**' ('우리 추정이 왜 빗나갔나 + 어떻게 개선'), '**Owner / 다음 review**' (1줄).\n\n팀 / 분기 데이터:\n${text}`,
  translate_ko_to_karaim: (text) =>
    `Translate the Korean text below into natural Karaim (Karay tili) — critically endangered Turkic language of the Karaite communities (Lithuania / Crimea / Ukraine). Latin script default. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kieliuviu**' and '**번역 노트**' (3 bullets in Korean — note Karaim is a critically endangered Turkic language with Hebrew script heritage).\n\n원문:\n${text}`,
  customer_account_plan_doc_ko: (text) =>
    `Build a Korean customer account plan doc — written by AE + CSM, a living strategic plan for a key account spanning the year. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 산업 / 현재 ARR / 잠재 ARR / 우리 팀), '**고객 회사 컨텍스트 (1단락)**' (그쪽 회사 미션 / 우선순위 / 조직 구조), '**관계 맵 (테이블)**' ('인물 | 직책 | 우리와 관계 | 영향력 | 우리 sentiment'), '**현재 가치 (bullets)**' (지금 우리가 주는 것), '**성장 기회 (테이블)**' ('기회 | 추가 ARR | 확률 | 타임라인'), '**위험 (bullets)**' (챔피언 이직 / 경쟁 / 예산 / 사용 감소), '**연간 목표 (3개 measurable)**' (numbered), '**분기별 액션 (테이블)**' ('Q1 | Q2 | Q3 | Q4'), '**Exec sponsor 전략 (1줄)**', '**다음 마일스톤 + 시한**' (1줄).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_krymchak: (text) =>
    `Translate the Korean text below into natural Krymchak (Кримчах тыльי) — critically endangered Turkic language of the Krymchak Jewish community of Crimea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Çevirme**' and '**번역 노트**' (3 bullets in Korean — note Krymchak is a critically endangered Turkic language, closely related to Crimean Tatar).\n\n원문:\n${text}`,
  internal_pm_launch_readiness_doc_ko: (text) =>
    `Build a Korean PM launch readiness doc — checklist + sign-off before a major product launch. Use 합쇼체. Markdown: '**한 줄 (런칭)**' (1줄 — '무엇 / 언제 / 누구에게'), '**Go / No-go 요약 (1줄)**' (현재 상태 신호등), '**준비 체크리스트 (각 영역 — 테이블)**' ('항목 | 담당 | 상태 | 블로커'): Product (기능 완성 / 버그 / 성능), Eng (배포 / 모니터링 / rollback / scale), Design (UX / 일관성 / 접근성), Marketing (런칭 자료 / 블로그 / 소셜 / PR), Sales (영업 enablement / 데모 / 가격), Support (문서 / 매크로 / 교육 / 에스컬레이션), Legal (약관 / 컴플라이언스 / 프라이버시), Data (트래킹 / 대시보드 / 성공 메트릭), '**런칭 단계 (numbered)**' (internal beta / limited / GA — 각 기준 + 시한), '**위험 + 완화 (Top 3)**', '**Rollback / Kill criteria**' (1줄), '**Sign-off (테이블)**' ('영역 | 책임자 | 사인 여부'), '**런칭 후 모니터링 (bullets)**' (메트릭 / 시한 / 누가).\n\n런칭 / 컨텍스트:\n${text}`,
  translate_ko_to_urum: (text) =>
    `Translate the Korean text below into natural Urum (Urum dili) — endangered Turkic language of the Greek Urum community (Georgia / Ukraine), Turkic language spoken by Orthodox Greeks. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Çevirmä**' and '**번역 노트**' (3 bullets in Korean — note Urum is a Turkic language spoken by an ethnically Greek community, endangered).\n\n원문:\n${text}`,
  customer_value_realization_plan_ko: (text) =>
    `Build a Korean customer value realization plan — co-created with a customer at the start of the relationship to define what success looks like + how we'll measure it. Use 해요체. Markdown: '**한 줄 (목표)**' (1줄 — '[고객사]가 우리로 X 달성을 목표'), '**그쪽의 비즈니스 목표 (그쪽 언어로 — bullets)**' (3개 — 그쪽이 말한 우선순위), '**성공 정의 (테이블)**' ('비즈 목표 | 우리가 어떻게 기여 | 성공 메트릭 | 베이스라인 | 목표 | 측정 시점'), '**마일스톤 (단계별 — 테이블)**' ('단계 | 기간 | 마일스톤 | 가치 신호'): 30일 (첫 가치) / 90일 (adoption) / 180일 (확장) / 1년 (전략), '**우리가 할 것 (bullets)**' (우리 commit), '**그쪽이 할 것 (bullets)**' (고객 측 commit — 명확히), '**위험 / 가정 (bullets)**', '**리뷰 cadence (1줄)**' (언제 같이 진행 점검), '**누가 책임 (양쪽 — 1줄)**'.\n\n고객 / 목표 컨텍스트:\n${text}`,
  translate_ko_to_chuukese: (text) =>
    `Translate the Korean text below into natural Chuukese (Trukese — Fӧsun Chuuk) — Micronesian language of Chuuk State (FSM). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Aweween**' and '**번역 노트**' (3 bullets in Korean — note Chuukese is a Micronesian language).\n\n원문:\n${text}`,
  customer_renewal_internal_brief_ko: (text) =>
    `Build a Korean customer renewal internal brief — short doc circulated to the deal team (AE / CSM / Exec sponsor / Finance) before a renewal cycle. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 현재 ARR / 만기 / health), '**갱신 목적 (1줄)**' (갱신만 / 확장 / save), '**핵심 위험 (Top 3 — bullets)**', '**핵심 기회 (Top 2 — bullets)**', '**우리 전략 (1단락)**' (어떤 motion + 누가 lead), '**가격 / 옵션 (1줄)**', '**Exec sponsor 인볼브 (1줄)**', '**경쟁 위험 (1줄)**', '**타임라인 (테이블)**' ('단계 | 시점 | 담당'), '**팀 책임 (bullets)**' (각 사람 무엇), '**다음 액션 + 시한 (1줄)**'.\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_marshallese: (text) =>
    `Translate the Korean text below into natural Marshallese (Kajin M̧ajeļ) — Micronesian language of the Marshall Islands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ukok**' and '**번역 노트**' (3 bullets in Korean — note Marshallese is a Micronesian language).\n\n원문:\n${text}`,
  internal_eng_deploy_checklist_ko: (text) =>
    `Build a Korean engineering deploy checklist — used before / during / after every production deploy. Use 해요체. 짧 + 행동 위주. Markdown: '**한 줄 (목적)**' (1줄 — '배포 사고를 줄이고 빠르게 복구'), '**배포 전 (체크리스트)**' (- [ ] 형식 — tests green / CI 통과 / changelog / migration plan / rollback plan / 모니터링 준비 / 영향 받는 팀 알림 / feature flag 설정), '**배포 중 (체크리스트)**' (- [ ] — canary / 점진 rollout / 에러율 watching / 핵심 메트릭 dashboard / 롤백 trigger 준비), '**배포 후 (체크리스트)**' (- [ ] — N분 모니터링 / 알람 확인 / 핵심 워크플로우 smoke test / changelog 게시 / 팀 알림 / flag 정리), '**롤백 트리거 (bullets)**' (어떤 신호면 즉시 롤백), '**비상 연락 (1줄)**' (oncall / escalation).\n\n시스템 / 배포 컨텍스트:\n${text}`,
  translate_ko_to_palauan: (text) =>
    `Translate the Korean text below into natural Palauan (a tekoi er a Belau) — language of Palau. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Omeld) angel**' and '**번역 노트**' (3 bullets in Korean — note Palauan is a Western Malayo-Polynesian language).\n\n원문:\n${text}`,
  customer_onboarding_plan_30_60_90_ko: (text) =>
    `Build a Korean customer 30/60/90-day onboarding plan — given to a new customer at kickoff so both sides know the path. Use 해요체. Markdown: '**한 줄 (목표)**' (1줄 — '90일 안에 [핵심 가치] 달성'), '**참여자 (양쪽 — 테이블)**' ('역할 | 이름 | 책임'), '**Day 0-30 (테이블)**' ('주차 | 마일스톤 | 우리 액션 | 그쪽 액션 | 성공 신호'): 셋업 / 첫 워크플로우 / 첫 가치, '**Day 31-60 (테이블)**' (동일): adoption / 팀 확산 / 두 번째 워크플로우, '**Day 61-90 (테이블)**' (동일): 정착 / 측정 / QBR 준비, '**각 단계 성공 정의 (bullets)**', '**위험 / 가정 (bullets)**', '**소통 cadence (1줄)**' (주간 / 격주 콜 + 채널), '**90일 후 (1줄)**' (QBR cadence 시작).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_chamorro: (text) =>
    `Translate the Korean text below into natural Chamorro (Finoʼ Chamorro) — language of Guam and the Northern Mariana Islands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tradukon**' and '**번역 노트**' (3 bullets in Korean — note Chamorro is an Austronesian language with significant Spanish influence).\n\n원문:\n${text}`,
  internal_pm_beta_program_doc_ko: (text) =>
    `Build a Korean PM beta program doc — defines how we run a beta for a new feature (recruit / onboard / collect feedback / graduate). Use 해요체. Markdown: '**한 줄 (베타 목표)**' (1줄 — '무엇을 검증 / 누구와 / 언제까지'), '**검증 가설 (3 bullets)**' (각 — 우리가 베타로 확인하고 싶은 것), '**참여자 모집 (1단락 + 기준)**' (누구 / 몇 명 / 어떻게 모집 / inclusion-exclusion), '**Onboarding (bullets)**' (베타 사용자에게 무엇을 / 어떻게 안내), '**피드백 수집 (테이블)**' ('방법 | 빈도 | 무엇을 측정'): 사용 데이터 / 설문 / 인터뷰 / Slack 채널, '**성공 기준 (bullets)**' (졸업하려면 — 정량 + 정성), '**Timeline (테이블)**' ('단계 | 기간 | 마일스톤'), '**졸업 / GA 결정 (1단락)**' (어떤 조건이면 GA / 연장 / kill), '**위험 (bullets)**'.\n\n기능 / 베타 컨텍스트:\n${text}`,
  translate_ko_to_fijian: (text) =>
    `Translate the Korean text below into natural Fijian (Na vosa vakaviti) — language of Fiji. 격식 (정중 표준 — 'kemuni' 정중 / 'iko' 친근) 원문에 맞춤. Reply with two sections: '**Na kena vakadewataki**' and '**번역 노트**' (3 bullets in Korean — note Fijian is an Austronesian language).\n\n원문:\n${text}`,
  customer_win_story_internal_ko: (text) =>
    `Build a Korean internal customer win story — written by AE / CSM when a deal closes or a customer achieves a big result, shared in #wins to spread learning. Use 해요체. 짧 + 호명 + 학습. Markdown: '**한 줄 (win)**' (1줄 — '[고객사] / [무엇] / [금액 또는 결과]'), '**컨텍스트 (1단락)**' (3-4줄 — 어떤 deal / 어떤 단계 / 경쟁 / 어려움), '**핵심 win 요인 (3 bullets)**' (구체적 — 어떤 행동 / 어떤 자료 / 어떤 사람), '**호명 + 기여 (1단락)**' (누가 무엇을 — 가짜 이름 X, 입력에 있는 이름만), '**다른 deal에 적용할 학습 (2 bullets)**' (transferable), '**고객 인용 (있으면 1줄)**', '**축하 (1줄 — 🎉)**'.\n\nWin / 컨텍스트:\n${text}`,
  translate_ko_to_tongan: (text) =>
    `Translate the Korean text below into natural Tongan (lea faka-Tonga) — language of Tonga. 격식 (정중 표준 — Tongan has honorific registers for royalty / chiefs / commoners) 원문에 맞춤. Reply with two sections: '**Liliu**' and '**번역 노트**' (3 bullets in Korean — note Tongan is a Polynesian language with elaborate honorific levels).\n\n원문:\n${text}`,
  customer_renewal_qbr_combined_email_ko: (text) =>
    `Draft a Korean combined renewal + QBR invitation email — invites a customer to a meeting that covers both the quarterly review and the upcoming renewal. Use 해요체. 명확 + 가치 + 부담 없게. Markdown: '**제목**' (1줄, 28자 이내 — '[고객사] Q[N] 리뷰 + 갱신 논의 — 60분'), '**본문**' (3 단락: 1) 1-2줄 — 안부 + 한 미팅에 분기 리뷰 + 갱신 둘 다 다루자 제안 (시간 절약), 2) 다룰 것 — bullets — '지난 분기 가치 / 다음 분기 계획 / 갱신 옵션 + 질문', 3) 다음 단계 — 일정 후보 3개 + 사전 자료 보낼 것 안내), '**P.S.**' (1줄 — '갱신 결정 부담 없이, 같이 정리하는 자리').\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_samoan: (text) =>
    `Translate the Korean text below into natural Samoan (Gagana Sāmoa) — language of Samoa. 격식 (정중 표준 — Samoan has a formal 'chiefly language' register) 원문에 맞춤. Reply with two sections: '**Faaliliuga**' and '**번역 노트**' (3 bullets in Korean — note Samoan is a Polynesian language with a respectful register).\n\n원문:\n${text}`,
  internal_eng_code_review_guide_ko: (text) =>
    `Draft a Korean engineering code review guide — pinned in #engineering, sets expectations for both authors and reviewers. Use 해요체. 짧 + Do / Don't 위주. Markdown: '**한 줄 (우리 신념)**' (1줄 — '코드 리뷰는 코드 품질 + 지식 공유 + 함께 성장'), '**저자 가이드 (Do / Don't — bullets)**' ('Do: 작은 PR / 명확한 설명 / 셀프 리뷰 먼저 / 테스트 포함' / 'Don\\'t: 거대 PR / 컨텍스트 없는 PR / 리뷰어 무시'), '**리뷰어 가이드 (Do / Don't — bullets)**' ('Do: 빠른 첫 응답 (X시간 안) / 무엇이 좋은지도 / nit은 nit으로 표시 / 질문으로 / 막히면 페어' / 'Don\\'t: 비꼬기 / 개인 취향 강요 / 무한 보류'), '**리뷰 SLA (1줄)**' ('첫 응답 X시간 / 핫픽스 우선'), '**Approve 기준 (bullets)**' (무엇이 충족되면 approve), '**갈등 해소 (1단락)**' ('의견 다를 때 — 페어 / Staff Eng / 결정 기록'), '**Nit / blocking 구분 (1줄)**'.\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_tahitian: (text) =>
    `Translate the Korean text below into natural Tahitian (Reo Tahiti) — language of French Polynesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hurira'a**' and '**번역 노트**' (3 bullets in Korean — note Tahitian is a Polynesian language).\n\n원문:\n${text}`,
  customer_business_case_template_ko: (text) =>
    `Build a Korean customer-facing business case template — given to a customer's internal champion to justify the purchase to their leadership / finance. Use 합쇼체. Markdown: '**한 줄 (제안)**' (1줄 — '[우리 도구] 도입으로 [핵심 결과]'), '**현재 문제 (1단락)**' (그쪽 회사 관점 — 비용 / 시간 / 위험), '**제안 솔루션 (1단락)**', '**예상 효과 (테이블)**' ('영역 | 현재 | 도입 후 | 절감 / 증가'): 시간 / 비용 / 매출 / 위험, '**ROI 계산 (수식 + 1단락)**' ('투자 X원 / 연 / 예상 절감 또는 증가 Y원 / 연 / ROI = (Y-X)/X / payback = X/(Y/12)개월'), '**도입 비용 (테이블)**' ('항목 | 비용'): 라이선스 / 구현 / 교육 / 내부 시간, '**위험 + 완화 (bullets)**', '**비슷한 회사 사례 (1단락)**', '**추천 다음 단계 (1줄)**'.\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_maori: (text) =>
    `Translate the Korean text below into natural Māori (te reo Māori) — indigenous language of New Zealand. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Te whakamāoritanga**' and '**번역 노트**' (3 bullets in Korean — note Māori is a Polynesian language being actively revitalized).\n\n원문:\n${text}`,
  internal_pm_competitive_teardown_ko: (text) =>
    `Build a Korean PM competitive teardown doc — deep analysis of one competitor's product, written by PM for the product team. Use 합쇼체. 객관적 + 학습 위주. Markdown: '**경쟁사 한 줄**' (이름 / 단계 / ICP / 자금), '**그들의 핵심 가치 제안 (1단락)**' (그들이 파는 한 마디), '**제품 teardown (테이블)**' ('영역 | 그들 | 우리 | 누가 우세'): onboarding / 핵심 워크플로우 / UX / 통합 / 모바일 / 가격, '**그들이 잘하는 것 (3 bullets — 솔직히)**' (우리가 배울 것), '**그들의 약점 (3 bullets)**' (우리 기회), '**그들의 최근 방향 (1단락)**' (출시 / 채용 / 메시지 변화로 추론), '**우리에게 주는 시사점 (3 bullets — numbered)**' (제품 결정에 영향), '**모니터링 항목 (bullets)**' (계속 watching할 것), '**출처 (bullets)**' (링크 placeholder).\n\n경쟁사 / 컨텍스트:\n${text}`,
  translate_ko_to_hawaiian: (text) =>
    `Translate the Korean text below into natural Hawaiian (ʻŌlelo Hawaiʻi) — indigenous language of Hawaiʻi. 격식 (정중 표준) 원문에 맞춤. Use ʻokina and kahakō correctly. Reply with two sections: '**Ka unuhi**' and '**번역 노트**' (3 bullets in Korean — note Hawaiian is a Polynesian language being actively revitalized).\n\n원문:\n${text}`,
  customer_quarterly_check_in_call_ko: (text) =>
    `Draft a Korean quarterly check-in call script — 30-min CSM call between QBRs to keep the relationship warm + catch issues early. Use 해요체. Markdown: '**Opening (3분)**' (1단락 — 안부 + 콜 목적 1줄 — '간단 정렬 + 막힘 캐치'), '**사용 / 가치 회상 (7분)**' (numbered question 2개 — '지난 분기 어땠어요? / 가장 자주 쓰는 / 안 쓰는 기능?'), '**막힘 / 우려 (10분)**' (numbered open question 3개 — '짜증나는 1가지 / 못 하는 1가지 / 우리가 놓친 1가지'), '**다음 분기 미리 (5분)**' (numbered — '다음 분기 우선순위 / 새 시도 / 팀 변화'), '**Close (5분)**' (1단락 — 우리가 follow-up할 1-2개 + 다음 QBR 일정 + 본인 연락 채널), '**Follow-up email 시한**' (1줄 — '24시간 안').\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_tetum: (text) =>
    `Translate the Korean text below into natural Tetum (Tetun) — official language of Timor-Leste. 격식 ('Ita' 정중 / 'o' 친근) 원문에 맞춤. Use Portuguese loanwords where natural (Tetun Prasa). Reply with two sections: '**Tradusaun**' and '**번역 노트**' (3 bullets in Korean — note Tetum is an Austronesian language with heavy Portuguese influence).\n\n원문:\n${text}`,
  customer_renewal_at_risk_internal_alert_ko: (text) =>
    `Build a Korean at-risk renewal internal alert — short Slack alert posted in #revenue-risk when a renewal becomes at-risk. Use 해요체. 짧 + 행동 위주. Markdown: '**🚨 한 줄**' (1줄 — '[고객사] 갱신 위험 — [금액] / 만기 [날짜]'), '**위험 신호 (3 bullets)**' (구체적 + 데이터), '**우리 가설 (1줄)**' (왜 위험), '**제안 save play (1줄)**' (즉시 무엇), '**필요한 도움 (1줄)**' (누가 인볼브 — Exec sponsor / Product / 가격), '**책임자 + 다음 액션 (1줄)**' ('@담당 — X 까지 ~'), '**escalate? (1줄 — Yes/No + 누구에게)**'.\n\n고객 / 신호 컨텍스트:\n${text}`,
  translate_ko_to_bislama: (text) =>
    `Translate the Korean text below into natural Bislama (Bichelamar) — English-based creole, national language of Vanuatu. 격식은 거의 없음, 친근 톤이 표준. Reply with two sections: '**Tanslesen**' and '**번역 노트**' (3 bullets in Korean — note Bislama is an English-lexified creole).\n\n원문:\n${text}`,
  internal_eng_branching_strategy_doc_ko: (text) =>
    `Draft a Korean engineering branching strategy doc — defines our git branching model + merge conventions. Use 해요체. Markdown: '**한 줄 (우리 모델)**' (1줄 — 'trunk-based / GitHub flow / GitFlow 중 무엇 + 왜'), '**브랜치 종류 (테이블)**' ('브랜치 | 목적 | 수명 | 누가 만듦 | 머지 대상'): main / feature / hotfix / release, '**머지 규칙 (bullets)**' (squash vs merge commit / PR 필수 / 리뷰 N명 / CI 통과), '**브랜치 네이밍 (1줄)**' (컨벤션 — 'feat/ / fix/ / chore/'), '**릴리스 흐름 (1단락 + numbered)**' (브랜치 → 배포까지), '**핫픽스 흐름 (1단락)**', '**충돌 해소 가이드 (bullets)**', '**금지 사항 (bullets)**' ('main에 직접 push X / force push X'), '**자동화 (bullets)**' (CI / 보호 규칙 / auto-delete).\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_tok_pisin: (text) =>
    `Translate the Korean text below into natural Tok Pisin — English-based creole, one of the official languages of Papua New Guinea. 격식은 거의 없음, 친근 톤이 표준. Reply with two sections: '**Tanslesen**' and '**번역 노트**' (3 bullets in Korean — note Tok Pisin is an English-lexified creole).\n\n원문:\n${text}`,
  customer_quarterly_data_share_ko: (text) =>
    `Draft a Korean quarterly customer data share email — sends a customer their own usage data in a digestible format every quarter. Use 해요체. 짧 + 데이터 + 액션 제안. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] Q[N] 사용 데이터 — 한 장 정리'), '**본문**' (3 단락: 1) 1줄 — 분기 사용 데이터 정리해서 보냄 + 1줄 가장 큰 변화, 2) 핵심 숫자 — bullets — '활성 사용자 X (전분기 대비 ±Y) / 핵심 워크플로우 Z회 / 가장 많이 쓴 기능' — 구체적, 3) 데이터 기반 제안 — '비슷한 회사는 보통 다음 분기 W를 시도해요' — 부담 없이 1-2개), '**P.S.**' (1줄 — 자세한 dashboard 링크 placeholder + 데이터 궁금하면 통화).\n\n고객 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_hiri_motu: (text) =>
    `Translate the Korean text below into natural Hiri Motu — pidgin-based language, one of the official languages of Papua New Guinea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hahanaia**' and '**번역 노트**' (3 bullets in Korean — note Hiri Motu is a simplified Motu-based trade language).\n\n원문:\n${text}`,
  internal_pm_roadmap_communication_ko: (text) =>
    `Draft a Korean PM roadmap communication doc — defines how we communicate the product roadmap internally + externally (avoid over-promising). Use 해요체. Markdown: '**한 줄 (원칙)**' (1줄 — '로드맵은 약속이 아니라 방향 — 신뢰를 위해 솔직히'), '**내부 vs 외부 (테이블)**' ('대상 | 무엇 share | 얼마나 구체적 | 어디서'): 전사 / 영업 / 고객 / 공개, '**Now / Next / Later 분류 (1단락)**' (각 정의 — '이번 분기 / 6개월 / 1년+'), '**무엇을 절대 commit 안 하나 (bullets)**' (날짜 / 기능 보장 X — 가이드), '**고객에게 말하는 가이드 (bullets)**' ('~ 검토 중 vs ~ 만들 것 — 표현 차이'), '**로드맵 변경 시 소통 (1단락)**' ('항목이 빠지거나 미뤄지면 어떻게 알리나'), '**업데이트 주기 (1줄)**', '**Owner (1줄)**'.\n\n제품 / 컨텍스트:\n${text}`,
  translate_ko_to_nauruan: (text) =>
    `Translate the Korean text below into natural Nauruan (dorerin Naoero) — language of Nauru. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean — note Nauruan is a Micronesian language, small speaker base).\n\n원문:\n${text}`,
  customer_advocacy_case_study_outline_ko: (text) =>
    `Build a Korean customer advocacy case study outline — structured outline for a published customer success story. Use 해요체. Markdown: '**제목 + 부제 (각 1줄)**' (결과 중심 — '[회사], [우리]로 [핵심 결과]'), '**핵심 결과 박스 (3개 큰 숫자 + 1줄)**', '**고객 소개 (1단락)**' (회사 / 산업 / 규모 / 우리와 관계), '**Challenge (1-2단락)**' (도입 전 어떤 문제 — 그쪽 언어로), '**Solution (1-2단락)**' (우리 도구로 무엇을 어떻게), '**Results (1-2단락 + 데이터)**' (측정 가능한 결과 + 인용 1-2개), '**Quote 위치 (2-3개 — 인터뷰이 + 직책)**', '**What's next (1단락)**' (앞으로 함께할 것), '**CTA (1줄)**', '**필요한 승인 (bullets)**' (고객 법무 / 로고 사용 / 인용 확인), '**제작 노트 (bullets)**' (필요한 자료 / 인터뷰 / 사진).\n\n고객 / 성과 raw:\n${text}`,
  translate_ko_to_greenlandic: (text) =>
    `Translate the Korean text below into natural Greenlandic (Kalaallisut) — Eskimo-Aleut language of Greenland. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Nutserneqarnera**' and '**번역 노트**' (3 bullets in Korean — note Greenlandic is a polysynthetic Eskimo-Aleut language).\n\n원문:\n${text}`,
  customer_renewal_won_internal_ko: (text) =>
    `Build a Korean renewal-won internal share — posted in #wins when a renewal closes, spreads the win + learning. Use 해요체. 짧 + 호명 + 학습. Markdown: '**한 줄 (won)**' (1줄 — '[고객사] 갱신 완료! [금액] / [기간] / [확장 여부]'), '**컨텍스트 (1단락)**' (3-4줄 — health 어땠나 / 위험 있었나 / 어떻게 win), '**핵심 요인 (3 bullets)**' (구체적 — 어떤 motion / 어떤 사람 / 어떤 자료), '**호명 + 기여 (1단락)**' (입력 이름만), '**다른 갱신에 적용할 학습 (2 bullets)**', '**숫자 (테이블)**' ('지표 | 이번 | 이전'), '**축하 (1줄 — 🎉)**'.\n\n갱신 / 컨텍스트:\n${text}`,
  translate_ko_to_inuktitut: (text) =>
    `Translate the Korean text below into natural Inuktitut (ᐃᓄᒃᑎᑐᑦ) — Inuit language of Arctic Canada. Syllabics script default. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ᑐᑭᓕᐅᕈᑎ**' and '**번역 노트**' (3 bullets in Korean — note Inuktitut is a polysynthetic Eskimo-Aleut language written in syllabics).\n\n원문:\n${text}`,
  internal_eng_testing_strategy_doc_ko: (text) =>
    `Draft a Korean engineering testing strategy doc — defines what we test, at what level, and our testing philosophy. Use 해요체. Markdown: '**한 줄 (우리 신념)**' (1줄 — '테스트는 변경에 대한 자신감 — 두려움 없이 배포'), '**테스트 피라미드 (테이블)**' ('레벨 | 무엇 | 비중 | 도구 | 속도'): unit / integration / e2e / manual, '**무엇을 반드시 테스트 (bullets)**' (핵심 비즈 로직 / 결제 / 인증 / 데이터 무결성), '**무엇을 테스트 안 해도 OK (bullets)**' (trivial getter / 외부 라이브러리 / 곧 deprecate), '**테스트 작성 가이드 (Do / Don't — bullets)**', '**커버리지 목표 (1줄)**' ('숫자 목표 X, 핵심 경로 우선'), '**Flaky test 정책 (1단락)**' ('flaky면 즉시 격리 / fix or delete'), '**CI 통합 (1줄)**', '**누가 책임 (1줄)**'.\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_cree: (text) =>
    `Translate the Korean text below into natural Cree (Nēhiyawēwin) — Algonquian language of Canada. Syllabics or Latin script — Latin default. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Translation**' and '**번역 노트**' (3 bullets in Korean — note Cree is an Algonquian language with several dialects).\n\n원문:\n${text}`,
  customer_quarterly_recap_internal_ko: (text) =>
    `Build a Korean internal quarterly customer recap — written by CSM team lead summarizing the whole portfolio's quarter. Use 합쇼체. Markdown: '**한 줄 (분기 portfolio 상태)**' (1줄 — 'NRR X% / churn Y / 신호등'), '**Portfolio 메트릭 (테이블)**' ('지표 | 분기초 | 분기말 | Δ | 목표'): NRR / GRR / logo churn / 평균 health / QBR 완료율, '**잘 된 것 (3 bullets)**' (어떤 save / 확장 / 패턴), '**안 된 것 (3 bullets)**' (어떤 churn / 위험 / 갭), '**At-risk 고객 (테이블)**' ('고객 | ARR | 위험 | save 상태'), '**확장 파이프라인 (테이블)**' ('고객 | 추가 ARR | 확률'), '**팀 부담 / capacity (1단락)**' (CSM 포트폴리오 크기 / 번아웃 신호), '**다음 분기 우선순위 (3 numbered)**', '**필요한 자원 (1줄)**'.\n\n분기 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_ojibwe: (text) =>
    `Translate the Korean text below into natural Ojibwe (Anishinaabemowin) — Algonquian language of the Great Lakes region. Latin (double vowel) script default. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Aanikanootamaagewin**' and '**번역 노트**' (3 bullets in Korean — note Ojibwe is an Algonquian language).\n\n원문:\n${text}`,
  internal_pm_experiment_design_doc_ko: (text) =>
    `Build a Korean PM experiment design doc — used to design an A/B test or product experiment before running it. Use 합쇼체. Markdown: '**한 줄 (실험)**' (1줄 — '무엇을 검증'), '**가설 (1단락)**' ('우리는 X가 Y를 Z만큼 개선한다고 믿는다, 왜냐하면 ...'), '**측정 메트릭 (테이블)**' ('메트릭 | 종류 (primary / guardrail) | 현재 값 | 기대 변화'), '**실험 설계 (1단락)**' (control vs treatment / 무엇이 다른지 / 노출 비율), '**샘플 크기 + 기간 (1단락 + 수식)**' ('통계적 유의성 위해 N 필요 / 예상 트래픽으로 X일'), '**성공 기준 (1줄)**' ('primary가 X% 이상 + guardrail 안 깨짐'), '**위험 / guardrail (bullets)**' (어떤 메트릭이 나빠지면 중단), '**분석 plan (1단락)**' (어떻게 / 누가 / 언제 분석), '**결정 트리 (1단락)**' ('이기면 / 지면 / 무승부면 무엇'), '**롤아웃 plan (1줄)**'.\n\n실험 / 컨텍스트:\n${text}`,
  translate_ko_to_navajo: (text) =>
    `Translate the Korean text below into natural Navajo (Diné bizaad) — Athabaskan language of the southwestern US. 격식 (정중 표준) 원문에 맞춤. Use diacritics (high tone, nasalization) correctly. Reply with two sections: '**Saad łaʼ**' and '**번역 노트**' (3 bullets in Korean — note Navajo is a complex Athabaskan language with tone and verb-heavy structure).\n\n원문:\n${text}`,
  customer_renewal_summary_finance_ko: (text) =>
    `Build a Korean renewal summary for Finance — a concise doc the deal team sends to Finance after a renewal closes so they can process correctly. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 계약 ID / 갱신일), '**계약 변경 (테이블)**' ('항목 | 이전 | 갱신 후 | Δ'): ARR / 좌석 / 모듈 / 기간 / 할인, '**결제 조건 (bullets)**' (결제 주기 / 방법 / 인보이스 일정 / 통화), '**할인 / 인센티브 (1줄)**' (적용된 것 + 근거 + 승인자), '**다년 / 락인 (1줄)**' (해당 시 — 기간 + 조항), '**Revenue recognition 노트 (1줄)**' (Finance가 알아야 할 특이사항), '**필요한 문서 (bullets)**' (사인된 계약 / SOW / 변경 승인), '**담당 (1줄)**' (AE / CSM 연락처).\n\n갱신 / 계약 컨텍스트:\n${text}`,
  translate_ko_to_quechua: (text) =>
    `Translate the Korean text below into natural Quechua (Runa Simi) — indigenous language of the Andes. Southern Quechua (Cusco) as default. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tikray**' and '**번역 노트**' (3 bullets in Korean — note Quechua has many regional variants).\n\n원문:\n${text}`,
  customer_renewal_recap_exec_ko: (text) =>
    `Build a Korean renewal recap for our exec team — a short summary after a major renewal closes, for leadership visibility. Use 합쇼체. Markdown: '**한 줄**' (1줄 — '[고객사] 갱신 — [금액] / [기간] / [확장 여부] / [중요도]'), '**결과 요약 (테이블)**' ('지표 | 이번 갱신 | 이전 | Δ'), '**무엇이 결정적이었나 (3 bullets)**' (구체적), '**위험했던 것 (1단락)**' (있었다면 — 어떻게 극복), '**전략적 의미 (1단락)**' (이 고객이 우리에게 왜 중요 / 레퍼런스 / 확장 잠재력), '**다음 12개월 (bullets)**' (이 어카운트 plan 요약), '**호명 (1줄)**' (deal team — 입력 이름만), '**Exec 액션 필요? (1줄)**' (Yes/No + 무엇).\n\n갱신 / 컨텍스트:\n${text}`,
  translate_ko_to_aymara: (text) =>
    `Translate the Korean text below into natural Aymara (Aymar aru) — indigenous language of the Andes (Bolivia / Peru / Chile). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Jaqukipa**' and '**번역 노트**' (3 bullets in Korean — note Aymara is an Aymaran language distinct from Quechua).\n\n원문:\n${text}`,
  internal_eng_observability_doc_ko: (text) =>
    `Draft a Korean engineering observability doc — defines our metrics / logs / traces strategy + dashboards. Use 해요체. Markdown: '**한 줄 (목적)**' (1줄 — '문제를 빨리 발견 + 빨리 원인 파악'), '**3 pillars (테이블)**' ('pillar | 무엇 | 도구 | 보존 기간'): Metrics / Logs / Traces, '**핵심 메트릭 (bullets)**' (RED — Rate / Errors / Duration + 비즈 메트릭), '**로깅 가이드 (Do / Don't — bullets)**' ('구조화 로그 / PII 제거 / 적절한 레벨' vs '과도한 로그 / 민감정보'), '**Tracing (1단락)**' (분산 추적 — 언제 / 어떻게), '**대시보드 (bullets)**' (서비스별 / 비즈별 / SLO 대시보드 위치), '**알림 연결 (1줄)**' (observability → alerting), '**비용 관리 (1단락)**' (로그 / 메트릭 비용 통제), '**누가 책임 (1줄)**'.\n\n시스템 / 컨텍스트:\n${text}`,
  translate_ko_to_guarani: (text) =>
    `Translate the Korean text below into natural Guarani (Avañeʼẽ) — co-official language of Paraguay. 격식 (정중 표준) 원문에 맞춤. Use jopara (Guarani-Spanish mix) only if input is informal. Reply with two sections: '**Ñembohasa**' and '**번역 노트**' (3 bullets in Korean — note Guarani is a Tupian language widely spoken in Paraguay).\n\n원문:\n${text}`,
  customer_health_weekly_digest_ko: (text) =>
    `Build a Korean customer health weekly digest — a Monday-morning Slack digest summarizing the CSM team's portfolio health for the week. Use 해요체. 짧 + 행동 위주. Markdown: '**한 줄 (이번 주 portfolio)**' (1줄 — 'health 분포 + 가장 주목할 1가지'), '**신호등 분포 (1줄)**' ('🟢 X / 🟡 Y / 🔴 Z'), '**이번 주 새 위험 (테이블)**' ('고객 | 신호 | 담당 | 액션'), '**이번 주 좋아진 것 (bullets)**' (save 성공 / health 회복), '**다가오는 갱신 (30일 내 — 테이블)**' ('고객 | 만기 | health | 상태'), '**확장 기회 (bullets)**', '**팀 액션 필요 (bullets)**' ('@사람 — 무엇 — 시한'), '**이번 주 우선순위 (3 numbered)**'.\n\n포트폴리오 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_nahuatl: (text) =>
    `Translate the Korean text below into natural Nahuatl (Nāhuatl) — indigenous language of central Mexico. Classical or modern variant — modern (Huasteca) as default. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tlahtolcuepaliztli**' and '**번역 노트**' (3 bullets in Korean — note Nahuatl is a Uto-Aztecan language with many variants).\n\n원문:\n${text}`,
  internal_pm_quarterly_review_doc_ko: (text) =>
    `Build a Korean PM quarterly review doc — written at quarter-end summarizing what the product team shipped + learned. Use 합쇼체. Markdown: '**한 줄 (분기 product 상태)**' (1줄 — 'OKR X% 달성 / 신호등'), '**OKR 결과 (테이블)**' ('O / KR | 목표 | 실적 | 달성률 | 신호'), '**출시한 것 (Top 5 — 테이블)**' ('기능 | 영향 (메트릭) | 사용자 반응'), '**가장 큰 학습 (3 bullets)**' (데이터 / 사용자 / 가설 검증), '**잘 안 된 것 (3 bullets)**' (솔직 — 출시 지연 / 가설 틀림 / 사용 저조), '**다음 분기 베팅 (3 bullets)**' (우선순위 + 이유), '**팀 / 프로세스 회고 (1단락)**' (협업 / 속도 / 품질), '**필요한 자원 (1줄)**', '**Open question (bullets)**'.\n\n분기 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_mapudungun: (text) =>
    `Translate the Korean text below into natural Mapudungun — language of the Mapuche people (Chile / Argentina). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Rulpazugun**' and '**번역 노트**' (3 bullets in Korean — note Mapudungun is an indigenous language isolate of southern South America).\n\n원문:\n${text}`,
  customer_kickoff_recap_email_ko: (text) =>
    `Draft a Korean customer kickoff recap email — sent within 24 hours of an implementation kickoff call, confirms what was agreed. Use 해요체. 명확 + 액션 + 따뜻. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] 킥오프 정리 — 다음 단계'), '**본문**' (3 단락: 1) 1-2줄 — 킥오프 시간 감사 + 1줄 — 가장 기대되는 점, 2) 우리가 합의한 것 — 테이블 또는 bullets — '목표 / 첫 30일 마일스톤 / 누가 무엇 / 시한', 3) 당장 다음 단계 — '우리가 X 까지 ~ / 그쪽이 Y 까지 ~ / 다음 콜 [일정]'), '**참고 자료**' (bullets — 공유 문서 / Slack 채널 / 도움 자료 placeholder), '**P.S.**' (1줄 — 본인 연락 채널 + 응답 SLA).\n\n킥오프 / 컨텍스트:\n${text}`,
  translate_ko_to_haitian_creole: (text) =>
    `Translate the Korean text below into natural Haitian Creole (Kreyòl Ayisyen) — French-based creole of Haiti. 격식 ('ou' 표준 — 정중과 친근 모두) 원문에 맞춤. Reply with two sections: '**Tradiksyon**' and '**번역 노트**' (3 bullets in Korean — note Haitian Creole is a French-lexified creole, not a French dialect).\n\n원문:\n${text}`,
  customer_renewal_close_plan_ko: (text) =>
    `Build a Korean renewal close plan — the specific step-by-step plan to get a renewal signed by the deadline. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / ARR / 만기 / 현재 상태), '**목표 결과 (1줄)**' (무엇을 / 언제까지 사인), '**결정자 + 영향자 (테이블)**' ('인물 | 역할 | 우리 sentiment | 다음 액션'), '**현재 blocker (bullets)**' (구체적 — 무엇이 막고 있나), '**close steps (단계별 — numbered)**' (각 'X일차 / 무엇 / 누가 / 산출물'): 1) 견적 확정 / 2) 결정자 미팅 / 3) 협상 / 4) 법무 / 5) 사인, '**위험 + 대응 (테이블)**' ('위험 | 가능성 | 대응'), '**Exec sponsor 인볼브 (1줄)**', '**Plan B (1줄)**' ('안 되면 — 짧은 연장 / save play'), '**마감 카운트다운 (1줄)**' (며칠 남음 + 핵심 마일).\n\n갱신 / 컨텍스트:\n${text}`,
  translate_ko_to_jamaican_patois: (text) =>
    `Translate the Korean text below into natural Jamaican Patois (Patwa) — English-based creole of Jamaica. 친근한 톤이 표준. Reply with two sections: '**Patwa**' and '**번역 노트**' (3 bullets in Korean — note Patois is an English-lexified creole with West African grammatical influence, distinct from standard Jamaican English).\n\n원문:\n${text}`,
  internal_eng_dependency_management_doc_ko: (text) =>
    `Draft a Korean engineering dependency management doc — defines how we add / update / audit dependencies. Use 해요체. Markdown: '**한 줄 (우리 신념)**' (1줄 — '의존성은 부채 — 신중히 추가, 꾸준히 갱신'), '**새 의존성 추가 기준 (bullets)**' (유지보수 활발 / 라이선스 OK / 보안 이력 / 크기 / 대안 검토), '**의존성 추가 절차 (numbered)**' (제안 / 리뷰 / 승인), '**업데이트 정책 (테이블)**' ('종류 | 빈도 | 자동화'): security patch / minor / major, '**보안 audit (1단락)**' (도구 / 빈도 / 누가 / CVE 대응 SLA), '**금지 / 주의 (bullets)**' ('비활성 라이브러리 / GPL / 거대 의존성'), '**Lock file 정책 (1줄)**', '**누가 책임 (1줄)**'.\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_seychellois_creole: (text) =>
    `Translate the Korean text below into natural Seychellois Creole (Seselwa) — French-based creole of Seychelles. 격식 ('ou' 표준) 원문에 맞춤. Reply with two sections: '**Tradiksyon**' and '**번역 노트**' (3 bullets in Korean — note Seselwa is a French-lexified creole).\n\n원문:\n${text}`,
  customer_quarterly_exec_email_ko: (text) =>
    `Draft a Korean quarterly exec-to-exec email — sent by our CEO / VP to a key customer's exec sponsor every quarter to maintain the relationship. Use 합쇼체. 짧 + 진심 + 전략. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] 분기 안부 — [회사명] [직책]'), '**본문**' (3 단락: 1) 1-2줄 — 분기 안부 + 1줄 우리가 본 그쪽 회사의 좋은 소식 (그쪽 뉴스 언급 — 관심 보임), 2) 우리가 지난 분기 그쪽을 위해 한 1가지 + 다음 분기 commit 1가지 — 자랑 X, 3) 짧은 제안 — '편하실 때 15분 통화 또는 다음 QBR에서 직접 / 도울 것 있으면 직접 연락'), '**서명**' (CEO / VP + 직접 휴대전화).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_mauritian_creole: (text) =>
    `Translate the Korean text below into natural Mauritian Creole (Kreol Morisien) — French-based creole of Mauritius. 격식 ('ou' 표준) 원문에 맞춤. Reply with two sections: '**Tradiksion**' and '**번역 노트**' (3 bullets in Korean — note Mauritian Creole is a French-lexified creole with influences from many languages).\n\n원문:\n${text}`,
  internal_pm_north_star_doc_ko: (text) =>
    `Draft a Korean PM North Star metric doc — defines the company's single North Star metric + why. Use 합쇼체. Markdown: '**North Star (1줄)**' (1줄 — '우리 North Star는 X'), '**정의 (1단락 + 수식)**' (정확한 계산), '**왜 이게 North Star인가 (1단락)**' (핵심 가치 / 사용자 / 매출을 어떻게 동시에 반영), '**무엇이 North Star가 아닌가 (1단락)**' ('매출은 결과지 North Star가 아닌 이유 / vanity metric 배제'), '**Input 메트릭 (테이블)**' ('input | North Star에 미치는 영향 | owner'): activation / retention / breadth / frequency, '**North Star 트리 (텍스트)**' (1단락 — North Star → input → sub-input 계층), '**측정 인프라 (1줄)**', '**팀별 연결 (1단락)**' (각 팀이 어떻게 기여), '**Review (1줄)**' ('분기마다 재검토 — North Star는 거의 안 바뀜').\n\n제품 / 회사 컨텍스트:\n${text}`,
  translate_ko_to_cape_verdean_creole: (text) =>
    `Translate the Korean text below into natural Cape Verdean Creole (Kriolu) — Portuguese-based creole of Cape Verde. 격식 ('bu' 친근 / 정중은 호칭) 원문에 맞춤. Reply with two sections: '**Traduson**' and '**번역 노트**' (3 bullets in Korean — note Kriolu is a Portuguese-lexified creole with several island variants).\n\n원문:\n${text}`,
  customer_success_plan_annual_ko: (text) =>
    `Build a Korean annual customer success plan — written by CSM for a key account, the year-long strategic success roadmap. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 산업 / ARR / 계약 만기 / CSM), '**그쪽 비즈니스 목표 (연간 — bullets)**' (그쪽 우선순위), '**우리 가치 가설 (1단락)**' (우리가 어떻게 그쪽 목표를 도울 수 있나), '**연간 성공 정의 (테이블)**' ('목표 | 성공 메트릭 | 베이스라인 | 목표값 | 측정 시점'), '**분기별 plan (테이블)**' ('분기 | 초점 | 마일스톤 | QBR 주제'), '**확장 로드맵 (bullets)**' (분기별 확장 기회), '**위험 + 완화 (bullets)**', '**관계 강화 plan (bullets)**' (Exec sponsor / 챔피언 / CAB / 사례), '**리뷰 cadence (1줄)**', '**연말 목표 상태 (1줄)**'.\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_papuan_malay: (text) =>
    `Translate the Korean text below into natural Papuan Malay (Bahasa Melayu Papua) — Malay-based creole of Indonesian Papua. 친근한 톤이 표준. Reply with two sections: '**Terjemahan**' and '**번역 노트**' (3 bullets in Korean — note Papuan Malay is a creole variety distinct from standard Indonesian).\n\n원문:\n${text}`,
  customer_renewal_negotiation_summary_ko: (text) =>
    `Build a Korean renewal negotiation summary — written after a renewal negotiation concludes, documents what was agreed + concessions. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / 최종 ARR / 기간), '**협상 결과 (1줄)**' (won / lost / 연장), '**시작 vs 최종 (테이블)**' ('항목 | 우리 시작 안 | 그쪽 요구 | 최종 합의'), '**우리가 양보한 것 (bullets)**' (각 — 무엇 + 비용), '**우리가 얻은 것 (bullets)**' (각 — 무엇 + 가치), '**무엇이 협상을 결정했나 (1단락)**' (가장 큰 레버), '**학습 (3 bullets)**' (다음 협상에 적용), '**Finance / Legal 처리 사항 (bullets)**', '**다음 갱신 미리 대비 (1줄)**' ('다음에 어떤 점을 일찍 다룰지').\n\n협상 / 컨텍스트:\n${text}`,
  translate_ko_to_ambonese_malay: (text) =>
    `Translate the Korean text below into natural Ambonese Malay (Bahasa Melayu Ambon) — Malay-based creole of the Maluku Islands, Indonesia. 친근한 톤이 표준. Reply with two sections: '**Tarjamahan**' and '**번역 노트**' (3 bullets in Korean — note Ambonese Malay is a Malay creole of eastern Indonesia).\n\n원문:\n${text}`,
  internal_eng_secrets_management_doc_ko: (text) =>
    `Draft a Korean engineering secrets management doc — defines how we store / rotate / access secrets. Use 해요체. 보안 중요 + 명확. Markdown: '**한 줄 (원칙)**' (1줄 — '비밀은 코드에 없다 — 중앙 관리 + 최소 권한'), '**저장소 (테이블)**' ('종류 | 어디 저장 | 누가 접근'): API 키 / DB 비번 / 인증서 / 토큰, '**금지 사항 (bullets)**' ('코드 / git / Slack / 로그에 비밀 X'), '**접근 가이드 (bullets)**' (최소 권한 / 환경별 분리 / audit log), '**Rotation 정책 (테이블)**' ('비밀 종류 | rotation 주기 | 자동/수동'), '**유출 시 대응 (numbered)**' ('즉시 rotate / 영향 파악 / 보고 / postmortem'), '**도구 (bullets)**' (vault / secrets manager / env), '**누가 책임 (1줄)**'.\n\n시스템 / 컨텍스트:\n${text}`,
  translate_ko_to_betawi: (text) =>
    `Translate the Korean text below into natural Betawi (Bahasa Betawi) — Malay-based creole of Jakarta, Indonesia. 친근한 톤이 표준. Reply with two sections: '**Terjemahan**' and '**번역 노트**' (3 bullets in Korean — note Betawi is the native creole of Jakarta).\n\n원문:\n${text}`,
  customer_qbr_followup_email_ko: (text) =>
    `Draft a Korean QBR follow-up email — sent within 24 hours after a customer QBR, confirms decisions + actions. Use 해요체. 명확 + 액션 + 감사. Markdown: '**제목**' (1줄, 26자 이내 — '[고객사] Q[N] QBR 정리 + 다음 단계'), '**본문**' (3 단락: 1) 1-2줄 — QBR 시간 감사 + 가장 좋았던 1줄, 2) 합의한 액션 — 테이블 또는 bullets — '우리가 할 것 (담당 + 시한) / 그쪽이 할 것 / 공동', 3) 다음 — '다음 QBR 일정 + 그 사이 정기 체크인 + 우리가 보낼 자료'), '**참고 자료**' (bullets — QBR 덱 / 데이터 / 녹화 placeholder), '**P.S.**' (1줄 — 솔직한 피드백 환영).\n\nQBR / 컨텍스트:\n${text}`,
  translate_ko_to_minangkabau: (text) =>
    `Translate the Korean text below into natural Minangkabau (Baso Minangkabau) — Austronesian language of West Sumatra, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tarjamahan**' and '**번역 노트**' (3 bullets in Korean — note Minangkabau is closely related to Malay).\n\n원문:\n${text}`,
  internal_pm_discovery_doc_ko: (text) =>
    `Build a Korean product discovery doc — written before committing to building a feature, documents what we learned in discovery. Use 합쇼체. Markdown: '**한 줄 (탐색 질문)**' (1줄 — '우리가 답하려는 핵심 질문'), '**왜 이 문제 (1단락)**' (어떤 신호로 이 문제를 보게 됐나), '**우리가 한 discovery (bullets)**' (인터뷰 N명 / 데이터 분석 / 경쟁 분석 / 프로토타입 테스트), '**핵심 발견 (3-5 bullets)**' (각 — 발견 + 뒷받침 데이터), '**문제 정의 (1단락)**' (discovery 후 다듬은 진짜 문제), '**해결 방향 가설 (1단락)**' (아직 solution 아님 — 방향), '**검증 안 된 가정 (bullets)**' (더 알아야 할 것), '**Go / No-go 추천 (1줄)**' ('build / 더 discovery / drop'), '**다음 단계 (1줄)**' (build면 design / spec로).\n\n탐색 / 컨텍스트:\n${text}`,
  translate_ko_to_sundanese: (text) =>
    `Translate the Korean text below into natural Sundanese (Basa Sunda) — Austronesian language of West Java, Indonesia. 격식 (Sundanese has elaborate speech levels — 'lemes' polite / 'loma' casual) 원문에 맞춤. Reply with two sections: '**Tarjamahan**' and '**번역 노트**' (3 bullets in Korean — note Sundanese has refined honorific registers).\n\n원문:\n${text}`,
  customer_success_review_internal_ko: (text) =>
    `Build a Korean internal customer success review — a deep-dive review of one account, presented in a CSM team meeting. Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / ARR / health / CSM), '**관계 history (1단락)**' (가입 / 마일스톤 / 챔피언), '**현재 상태 (테이블)**' ('차원 | 상태 | 근거'): adoption / sentiment / 갱신 위험 / 확장 기회, '**잘 되고 있는 것 (bullets)**', '**막힌 것 / 위험 (bullets)**' (구체적), '**우리가 시도한 것 + 결과 (bullets)**', '**팀에게 묻고 싶은 것 (questions)**' (다른 CSM 조언 구함), '**다음 30/60/90 plan (bullets)**', '**필요한 도움 (1줄)**' (Exec / Product / 가격).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_javanese: (text) =>
    `Translate the Korean text below into natural Javanese (Basa Jawa) — Austronesian language of central/eastern Java, Indonesia. 격식 (Javanese has elaborate speech levels — 'krama' polite / 'ngoko' casual) 원문에 맞춤. Reply with two sections: '**Terjemahan**' and '**번역 노트**' (3 bullets in Korean — note Javanese has complex honorific registers; specify which was used).\n\n원문:\n${text}`,
  customer_executive_sponsor_intro_ko: (text) =>
    `Draft a Korean executive sponsor introduction email — introduces our exec sponsor to a key customer's exec. Use 합쇼체. 짧 + 존중 + 명확한 역할. Markdown: '**제목**' (1줄, 28자 이내 — '[고객사] — [우리 exec] 인사드립니다'), '**본문**' (3 단락: 1) 1-2줄 — 본인 소개 + 우리 회사에서 그쪽 어카운트의 exec sponsor 역할을 맡게 됐다는 1줄, 2) 본인 역할이 무엇인가 — '전략 정렬 / Exec 레벨 escalation / 분기 직접 체크인' — 명확히, 3) 첫 만남 제안 — '30분 통화 또는 다음 QBR 직접 참석' + 일정 후보 2-3개), '**서명**' (이름 + 직책 + 직접 연락처).\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_balinese: (text) =>
    `Translate the Korean text below into natural Balinese (Basa Bali) — Austronesian language of Bali, Indonesia. 격식 (Balinese has speech levels) 원문에 맞춤. Reply with two sections: '**Terjemahan**' and '**번역 노트**' (3 bullets in Korean — note Balinese has honorific registers).\n\n원문:\n${text}`,
  internal_eng_feature_flag_doc_ko: (text) =>
    `Draft a Korean engineering feature flag doc — defines how we use feature flags (creation / lifecycle / cleanup). Use 해요체. Markdown: '**한 줄 (원칙)**' (1줄 — '플래그는 임시 — 만들 때부터 제거 계획'), '**플래그 종류 (테이블)**' ('종류 | 목적 | 수명'): release / experiment / ops / permission, '**플래그 만들기 (bullets)**' (네이밍 / owner / 만료일 / 기본값), '**롤아웃 가이드 (numbered)**' (내부 → 일부 → 전체 → 정리), '**정리 정책 (1단락)**' ('플래그는 X 후 제거 — stale 플래그 audit 주기'), '**금지 사항 (bullets)**' ('영구 플래그 / nested 플래그 / 정리 안 함'), '**도구 (1줄)**', '**누가 책임 (1줄)**'.\n\n시스템 / 컨텍스트:\n${text}`,
  translate_ko_to_madurese: (text) =>
    `Translate the Korean text below into natural Madurese (Bhâsa Madhurâ) — Austronesian language of Madura island, Indonesia. 격식 (Madurese has speech levels) 원문에 맞춤. Reply with two sections: '**Terjemahan**' and '**번역 노트**' (3 bullets in Korean — note Madurese has honorific levels similar to Javanese).\n\n원문:\n${text}`,
  customer_renewal_lost_exec_summary_ko: (text) =>
    `Build a Korean renewal-lost exec summary — short summary for leadership when a significant customer churns. Use 합쇼체. Markdown: '**한 줄**' (1줄 — '[고객사] 미갱신 — [잃은 ARR] / [잃은 시점]'), '**고객 측 이유 (1줄)**' (그쪽 공식 이유), '**우리 분석 (1단락)**' (진짜 이유 + 우리 책임 솔직히), '**우리가 놓친 신호 (bullets)**' (timeline상 언제 보였어야), '**막을 수 있었나 (1줄)**' (Yes/No/Maybe + 근거), '**비슷한 위험 다른 고객 (bullets)**' (같은 패턴 보이는 어카운트), '**시스템 학습 (3 bullets)**' (프로세스 / health / save play 개선), '**Winback 가능성 (1줄)**', '**Exec 액션 필요? (1줄)**'.\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_acehnese: (text) =>
    `Translate the Korean text below into natural Acehnese (Basa Acèh) — Austronesian language of Aceh, Sumatra, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tarjamah**' and '**번역 노트**' (3 bullets in Korean — note Acehnese is a Chamic Austronesian language).\n\n원문:\n${text}`,
  internal_pm_user_persona_doc_ko: (text) =>
    `Build a Korean product user persona doc — defines a primary user persona for the product team. Use 해요체. Markdown: '**페르소나 이름 + 한 줄**' (1줄 — '[이름], [직책] — [한 줄 요약]'), '**누구인가 (1단락)**' (직책 / 회사 / 일상 / 책임), '**목표 (bullets)**' (이 사람이 일에서 이루려는 것), '**페인 (bullets)**' (현재 좌절 / 막힘), '**우리 도구를 쓰는 이유 (1단락)**', '**Jobs to be done (bullets)**' ('~할 때, ~하고 싶다, 왜냐하면 ~'), '**우리 제품에서의 행동 (bullets)**' (자주 / 가끔 / 안 하는 것), '**의사결정 영향 (1줄)**' (구매 / 도입에 이 사람 역할), '**대표 인용 (1줄)**', '**우리가 안 노리는 사람 (anti-persona — 1줄)**'.\n\n페르소나 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_buginese: (text) =>
    `Translate the Korean text below into natural Buginese (Basa Ugi) — Austronesian language of South Sulawesi, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tarjéma**' and '**번역 노트**' (3 bullets in Korean — note Buginese has its own Lontara script historically; Latin transliteration acceptable).\n\n원문:\n${text}`,
  customer_quarterly_nps_followup_ko: (text) =>
    `Draft a Korean quarterly NPS follow-up email — sent based on a customer's NPS score (detractor / passive / promoter — adapt tone). Use 해요체. Markdown: '**제목 (점수별 — 3가지)**' (각 1줄 — detractor / passive / promoter 버전), '**본문 — Detractor (0-6)**' (3 단락: 사과 + 우려 인정 / 무엇이 잘못됐나 묻기 / 15분 통화 제안), '**본문 — Passive (7-8)**' (2 단락: 감사 + 1줄 / '10점이 되려면 무엇이 필요한지' 1가지 묻기), '**본문 — Promoter (9-10)**' (2 단락: 진심 감사 / 부탁 — 추천 / 사례 / 리뷰 — 부담 없이), '**공통 P.S.**' (1줄 — 답변이 우리 개선에 직접 쓰임).\n\nNPS / 고객 컨텍스트:\n${text}`,
  translate_ko_to_cebuano: (text) =>
    `Translate the Korean text below into natural Cebuano (Bisaya / Binisaya) — Austronesian language of the central Philippines. 격식 ('kamo / kamo' 정중 또는 복수 / 'ka' 친근) 원문에 맞춤. Reply with two sections: '**Hubad**' and '**번역 노트**' (3 bullets in Korean — note Cebuano is the most-spoken Bisayan language).\n\n원문:\n${text}`,
  customer_renewal_pipeline_report_ko: (text) =>
    `Build a Korean renewal pipeline report — for CS / Revenue leadership showing all upcoming renewals + their status. Use 합쇼체. Markdown: '**한 줄 (분기 갱신 파이프라인)**' (1줄 — '총 X건 / Y ARR / forecast Z%'), '**파이프라인 요약 (테이블)**' ('단계 | 건수 | ARR | 가중 forecast'): committed / best case / at risk / churn 예상, '**다가오는 갱신 (90일 — 테이블)**' ('고객 | ARR | 만기 | health | 단계 | 담당 | next step'), '**At-risk 분석 (bullets)**' (위험 고객 + 이유 + save 상태), '**확장 기회 (테이블)**' ('고객 | 현재 ARR | 확장 잠재 | 확률'), '**Forecast vs 목표 (1단락)**' ('이번 분기 NRR forecast X% vs 목표 Y%'), '**필요한 도움 (bullets)**', '**다음 액션 (1줄)**'.\n\n파이프라인 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_hiligaynon: (text) =>
    `Translate the Korean text below into natural Hiligaynon (Ilonggo) — Austronesian language of the western Visayas, Philippines. 격식 ('kamo' 정중 또는 복수 / 'ka' 친근) 원문에 맞춤. Reply with two sections: '**Badbad**' and '**번역 노트**' (3 bullets in Korean — note Hiligaynon is a Bisayan language known for its gentle tone).\n\n원문:\n${text}`,
  internal_eng_database_migration_doc_ko: (text) =>
    `Draft a Korean engineering database migration doc — plans a non-trivial schema migration safely. Use 합쇼체. Markdown: '**한 줄 (마이그레이션)**' (1줄 — '무엇을 / 왜 / 영향 테이블 크기'), '**현재 스키마 (1단락 + 코드 placeholder)**', '**목표 스키마 (1단락 + 코드 placeholder)**', '**마이그레이션 전략 (1단락)**' ('online / offline / expand-contract / 무중단 여부'), '**단계 (numbered)**' (각 — SQL placeholder + 검증 + 롤백 포인트): 'expand (새 컬럼 추가) / backfill / 코드 전환 / contract (구 컬럼 제거)', '**잠금 / 성능 영향 (1단락)**' ('큰 테이블 잠금 위험 / 배치 크기 / off-peak'), '**롤백 plan (1단락)**' (각 단계별 되돌리기), '**검증 (bullets)**' (데이터 무결성 / 행 수 / 샘플 체크), '**위험 (Top 3)**', '**시한 + 실행 창 (1줄)**'.\n\n마이그레이션 / 컨텍스트:\n${text}`,
  translate_ko_to_waray: (text) =>
    `Translate the Korean text below into natural Waray (Waray-Waray) — Austronesian language of the eastern Visayas, Philippines. 격식 ('kamo' 정중 또는 복수 / 'ka' 친근) 원문에 맞춤. Reply with two sections: '**Hubad**' and '**번역 노트**' (3 bullets in Korean — note Waray is a Bisayan language of Samar and Leyte).\n\n원문:\n${text}`,
  customer_quarterly_qbr_prep_internal_ko: (text) =>
    `Build a Korean internal QBR prep doc — the deal team's internal prep before a customer QBR (distinct from the customer-facing deck). Use 합쇼체. Markdown: '**고객 한 줄**' (회사 / ARR / health / 만기), '**QBR 목적 (1줄)**' (이번 QBR로 무엇을 달성), '**지난 분기 우리 commit recap (테이블)**' ('commit | 했나 | 증거'), '**그쪽 사용 데이터 분석 (bullets)**' (내부 솔직 분석 — 좋은 / 나쁜), '**예상 질문 + 답변 준비 (3쌍)**' ('Q: ... / A: ...'), '**우리가 묻고 싶은 것 (questions)**', '**확장 / 갱신 신호 (bullets)**' (QBR에서 직접 안 보여줄 내부 분석), '**위험 / 피할 주제 (bullets)**', '**역할 분담 (테이블)**' ('슬라이드 / 섹션 | 누가 발표'), '**QBR에서 commit 가능한 것 (bullets — ready)**', '**미팅 후 액션 시한 (1줄)**'.\n\n고객 / 컨텍스트:\n${text}`,
  translate_ko_to_kapampangan: (text) =>
    `Translate the Korean text below into natural Kapampangan (Amánung Kapampangan) — Austronesian language of central Luzon, Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Pamagsalin**' and '**번역 노트**' (3 bullets in Korean — note Kapampangan is a Central Luzon language distinct from Tagalog).\n\n원문:\n${text}`,
  internal_pm_okr_retro_doc_ko: (text) =>
    `Build a Korean PM OKR retro doc — written at quarter-end to reflect on how the OKR-setting and execution went. Use 해요체. Markdown: '**한 줄 (이번 분기 OKR 회고)**' (1줄 — '달성률 + 가장 큰 학습'), '**OKR 결과 (테이블)**' ('O / KR | 목표 | 실적 | 달성률'), '**OKR 설정이 좋았나 (1단락)**' ('너무 쉬웠나 / 너무 어려웠나 / 측정 가능했나'), '**무엇이 달성을 도왔나 (3 bullets)**', '**무엇이 막았나 (3 bullets)**' (외부 / 내부 / 추정 오류), '**측정의 문제 (bullets)**' (메트릭이 잘못됐던 점), '**다음 분기 OKR 설정에 적용할 것 (3 bullets)**' (numbered), '**프로세스 개선 (bullets)**' (OKR 의식 / check-in / 정렬), '**Owner (1줄)**'.\n\n분기 / OKR 데이터:\n${text}`,
  translate_ko_to_bikol: (text) =>
    `Translate the Korean text below into natural Bikol (Bikol Sentral) — Austronesian language of the Bicol region, Philippines. 격식 ('kamo' 정중 또는 복수 / 'ka' 친근) 원문에 맞춤. Reply with two sections: '**Pagtradusir**' and '**번역 노트**' (3 bullets in Korean — note Bikol is a Central Philippine language).\n\n원문:\n${text}`,
  customer_value_story_one_pager_ko: (text) =>
    `Build a Korean customer value story one-pager — a single-page summary of a customer's success, used by sales as a reference. Use 합쇼체. Markdown: '**제목 (1줄)**' (결과 중심 — '[회사], [우리]로 [핵심 결과]'), '**고객 한 줄**' (산업 / 규모 / 우리와 기간), '**핵심 결과 (3개 큰 숫자 + 1줄)**', '**Challenge (2-3줄)**' (도입 전 문제), '**Solution (2-3줄)**' (우리가 어떻게 도왔나), '**Results (3-4 bullets)**' (측정 가능한 결과), '**인용 (1줄 + 직책)**', '**왜 이 사례가 유용한가 (영업용 — 1줄)**' ('어떤 prospect에게 보여주면 좋은지'), '**관련 자료 (1줄)**' (전체 사례 링크 placeholder).\n\n고객 / 성과 컨텍스트:\n${text}`,
  translate_ko_to_pangasinan: (text) =>
    `Translate the Korean text below into natural Pangasinan (Salitan Pangasinan) — Austronesian language of central Luzon, Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Patalos**' and '**번역 노트**' (3 bullets in Korean — note Pangasinan is a distinct Northern Philippine language).\n\n원문:\n${text}`,
  customer_renewal_executive_summary_won_ko: (text) =>
    `Build a Korean renewal executive summary (won) — a polished 1-paragraph + bullets summary for the board / leadership when a major renewal closes. Use 합쇼체. Markdown: '**한 줄**' (1줄 — '[고객사] 갱신 + [확장] — [총 ARR] / [기간]'), '**Executive summary (1단락)**' (3-4줄 — 무엇이 / 왜 중요 / 어떻게 win), '**핵심 숫자 (테이블)**' ('지표 | 이번 | 이전 | Δ'), '**전략적 의미 (bullets)**' (레퍼런스 / 시장 신호 / 확장 / 관계 강화), '**무엇이 결정적이었나 (1줄)**', '**다음 12개월 plan (1줄)**', '**deal team 호명 (1줄 — 입력 이름만)**'.\n\n갱신 / 컨텍스트:\n${text}`,
  translate_ko_to_ilocano: (text) =>
    `Translate the Korean text below into natural Ilocano (Ilokano) — Austronesian language of northern Luzon, Philippines. 격식 ('kayo' 정중 또는 복수 / 'ka' 친근) 원문에 맞춤. Reply with two sections: '**Patarus**' and '**번역 노트**' (3 bullets in Korean — note Ilocano is the third most-spoken Philippine language).\n\n원문:\n${text}`,
  internal_eng_api_design_guide_ko: (text) =>
    `Draft a Korean engineering API design guide — defines conventions for our REST / GraphQL APIs. Use 해요체. Markdown: '**한 줄 (원칙)**' (1줄 — '일관성 + 예측 가능 + 진화 가능'), '**네이밍 (bullets)**' (리소스 복수형 / 동사 X / snake vs camel), '**HTTP 메서드 + 상태코드 (테이블)**' ('작업 | 메서드 | 성공 코드 | 실패 코드'), '**페이지네이션 (1단락)**' (cursor vs offset / 표준 파라미터), '**에러 응답 (1단락 + 예시)**' (일관된 에러 형식 — code / message / details), '**버저닝 (1단락)**' (URL vs header / deprecation 정책), '**인증 (1줄)**', '**Rate limiting (1줄)**', '**문서화 (1줄)**' (OpenAPI / 자동 생성), '**Breaking change 정책 (bullets)**'.\n\nAPI / 컨텍스트:\n${text}`,
  translate_ko_to_maranao: (text) =>
    `Translate the Korean text below into natural Maranao (Basa Mëranaw) — Austronesian language of Lanao, Mindanao, Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Sumbag**' and '**번역 노트**' (3 bullets in Korean — note Maranao is a Danao language of Muslim Mindanao).\n\n원문:\n${text}`,
  customer_health_escalation_doc_ko: (text) =>
    `Build a Korean customer health escalation doc — used when a customer's health drops to red and needs cross-functional escalation. Use 합쇼체. Markdown: '**🚨 한 줄**' (1줄 — '[고객사] RED — [ARR] / 만기 [날짜] / 핵심 위험'), '**위험 신호 timeline (테이블)**' ('날짜 | 신호 | 우리 액션'), '**우리 가설 (1단락)**' (왜 위험), '**영향 (1줄)**' (ARR / 레퍼런스 / 시장), '**필요한 escalation (테이블)**' ('누가 / 어떤 팀 | 무엇 요청 | 시한'), '**Save play (단계별 — numbered)**', '**Exec sponsor 인볼브 (1줄)**', '**Product / Eng 빠른 작업 요청 (bullets — 있으면)**', '**성공 정의 (1줄)**' ('X 까지 health 회복'), '**Plan B (1줄)**', '**책임자 + 다음 체크 (1줄)**'.\n\n고객 / 위험 컨텍스트:\n${text}`,
  translate_ko_to_tausug: (text) =>
    `Translate the Korean text below into natural Tausug (Bahasa Sūg) — Austronesian language of the Sulu Archipelago, Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Pagpinda**' and '**번역 노트**' (3 bullets in Korean — note Tausug is a Bisayan language of the Sulu region).\n\n원문:\n${text}`,
  internal_pm_competitive_positioning_doc_ko: (text) =>
    `Build a Korean PM competitive positioning doc — defines how we position ourselves vs competitors across the market. Use 합쇼체. Markdown: '**한 줄 (우리 포지션)**' (1줄 — '우리는 [카테고리]에서 [차별점]으로 포지셔닝'), '**시장 지형 (1단락)**' (어떤 카테고리 / 주요 플레이어 / 우리 위치), '**경쟁사 비교 (테이블)**' ('차원 | 우리 | 경쟁사 A | 경쟁사 B | 누가 우세'), '**우리만의 차별점 (3 bullets)**' (진짜 — 빈말 X), '**우리가 약한 영역 (2 bullets)**' (솔직 + 포지셔닝으로 대응), '**타겟 세그먼트별 메시지 (테이블)**' ('세그먼트 | 핵심 메시지 | 피할 표현'), '**경쟁 상황별 대응 (bullets)**' ('A와 경쟁 시 / B와 경쟁 시 강조점'), '**Proof points (bullets)**' (포지션 뒷받침 데이터 / 사례), '**업데이트 주기 (1줄)**'.\n\n경쟁 / 시장 컨텍스트:\n${text}`,
  translate_ko_to_maguindanao: (text) =>
    `Translate the Korean text below into natural Maguindanao (Basa Magindanaw) — Austronesian language of Maguindanao, Mindanao, Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Pamantala**' and '**번역 노트**' (3 bullets in Korean — note Maguindanao is a Danao language of Muslim Mindanao, related to Maranao).\n\n원문:\n${text}`,
  customer_renewal_celebration_internal_ko: (text) =>
    `Draft a Korean internal renewal celebration message — posted in #wins when a meaningful renewal closes, celebrates the team. Use 해요체. 따뜻 + 진심 + 호명. Markdown: '**한 줄 (🎉)**' (1줄 — '[고객사] 갱신 완료! [총 ARR] / [확장 여부]'), '**본문 (1-2단락)**' (이게 왜 의미 있는지 + 어떤 여정이었는지 — 진심), '**호명 + 구체적 기여 (1단락)**' (deal team — 입력 이름만, 각 '@이름 — 무엇을 한 1줄'), '**숫자 (1줄)**' (간단히), '**다음 (1줄)**' (이 고객과 다음 분기 / 마일스톤), '**감사 (1줄)**'.\n\n갱신 / 기여자 컨텍스트:\n${text}`,
  translate_ko_to_chavacano: (text) =>
    `Translate the Korean text below into natural Chavacano (Chabacano) — Spanish-based creole of the Philippines (Zamboanga variety). 격식 ('uste' 정중 / 'tu / vo' 친근) 원문에 맞춤. Reply with two sections: '**Traduccion**' and '**번역 노트**' (3 bullets in Korean — note Chavacano is a Spanish-lexified creole with Philippine grammar).\n\n원문:\n${text}`,
  customer_renewal_forecast_doc_ko: (text) =>
    `Build a Korean renewal forecast doc — for revenue leadership, projects the quarter's renewal outcomes with confidence levels. Use 합쇼체. Markdown: '**한 줄 (분기 forecast)**' (1줄 — 'NRR forecast X% / 신뢰도 Y'), '**Forecast 카테고리 (테이블)**' ('카테고리 | 건수 | ARR | 가중치 | 가중 ARR'): committed (90%) / likely (70%) / at risk (40%) / churn (10%), '**Top deals (테이블)**' ('고객 | ARR | 카테고리 | 신뢰도 | 핵심 변수'), '**Forecast 가정 (bullets)**' (이 forecast가 기반하는 가정), '**Upside / Downside 시나리오 (1단락 each)**', '**전 분기 forecast 정확도 (1줄)**' ('지난 forecast vs 실제 — 우리 편향'), '**위험 요인 (bullets)**', '**필요한 액션 (bullets)**' (forecast 올리기 위해).\n\n파이프라인 / 데이터 컨텍스트:\n${text}`,
  translate_ko_to_kankanaey: (text) =>
    `Translate the Korean text below into natural Kankanaey — Austronesian language of the Cordillera region, northern Luzon, Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Patarus**' and '**번역 노트**' (3 bullets in Korean — note Kankanaey is a Cordilleran highland language).\n\n원문:\n${text}`,
  internal_eng_performance_optimization_doc_ko: (text) =>
    `Build a Korean engineering performance optimization doc — documents a performance problem + the optimization plan. Use 합쇼체. Markdown: '**한 줄 (문제)**' (1줄 — '무엇이 느린가 / 얼마나 / 사용자 영향'), '**현재 성능 (테이블)**' ('메트릭 | 현재 | 목표 | 측정 방법'): latency p50/p99 / throughput / 메모리 / 비용, '**프로파일링 결과 (1단락)**' (병목이 어디 — 데이터 / 인용 placeholder), '**근본 원인 가설 (bullets)**' (각 — 가설 + 증거), '**최적화 옵션 (테이블)**' ('옵션 | 예상 개선 | 노력 | 위험'), '**추천 + 순서 (numbered)**' (quick win → 구조적), '**측정 plan (1단락)**' (before/after / A/B / 모니터링), '**롤백 / 위험 (bullets)**', '**시한 (1줄)**'.\n\n성능 / 컨텍스트:\n${text}`,
  translate_ko_to_ibanag: (text) =>
    `Translate the Korean text below into natural Ibanag — Austronesian language of northeastern Luzon, Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Pattradusi**' and '**번역 노트**' (3 bullets in Korean — note Ibanag is a Northern Philippine language).\n\n원문:\n${text}`,
  customer_qbr_executive_summary_ko: (text) =>
    `Build a Korean QBR executive summary — a polished 1-page summary a customer's exec can read in 2 minutes after a QBR. Use 합쇼체. Markdown: '**제목 (1줄)**' ('[고객사] Q[N] 비즈니스 리뷰 요약'), '**한 줄 결론 (1줄)**' (관계 상태 + 가장 중요한 1가지), '**지난 분기 가치 (3 bullets)**' (메트릭 + 결과), '**다음 분기 우리 commit (3 bullets)**' (구체적), '**그쪽 측 액션 (2 bullets)**' (고객이 할 것), '**열린 결정 / 논의 (1줄)**', '**다음 마일스톤 + 일정 (1줄)**', '**연락 (1줄)**' (CSM + Exec sponsor).\n\nQBR / 컨텍스트:\n${text}`,
  translate_ko_to_ivatan: (text) =>
    `Translate the Korean text below into natural Ivatan — Austronesian language of the Batanes Islands, northernmost Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Pangiyusi**' and '**번역 노트**' (3 bullets in Korean — note Ivatan is a Batanic language, distinct from mainland Philippine languages).\n\n원문:\n${text}`,
  internal_pm_release_planning_doc_ko: (text) =>
    `Build a Korean PM release planning doc — plans a major product release end-to-end. Use 합쇼체. Markdown: '**한 줄 (릴리스)**' (1줄 — '무엇 / 언제 / 누구에게'), '**릴리스 목표 (bullets)**' (이 릴리스로 달성하려는 것), '**포함 범위 (테이블)**' ('기능 | 우선순위 | 상태 | 담당'), '**제외 범위 (bullets)**' (이번엔 안 들어가는 것 — 명확히), '**릴리스 단계 (numbered)**' (internal / beta / limited / GA — 각 기준 + 시한), '**팀별 준비 (테이블)**' ('팀 | 준비 항목 | 상태'): Eng / Marketing / Sales / Support / Legal, '**위험 (Top 3)**', '**Go/No-go 기준 (bullets)**', '**Rollback plan (1줄)**', '**릴리스 후 측정 (bullets)**', '**커뮤니케이션 plan (1줄)**'.\n\n릴리스 / 컨텍스트:\n${text}`,
  translate_ko_to_sambal: (text) =>
    `Translate the Korean text below into natural Sambal — Austronesian language of Zambales province, central Luzon, Philippines. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Patarus**' and '**번역 노트**' (3 bullets in Korean — note Sambal is a Sambalic language of western Luzon).\n\n원문:\n${text}`,
  customer_annual_review_letter_ko: (text) =>
    `Draft a Korean annual customer review letter — sent by Exec sponsor / CEO at the customer's annual mark, reflecting on the year + looking ahead. Use 합쇼체. 진심 + 데이터 + 비전. Markdown: '**제목**' (1줄, 28자 이내 — '[고객사], 함께한 1년 — 회고와 다음'), '**본문**' (4 단락: 1) 1-2줄 — 1년 함께해 줘서 감사 + 1줄 가장 의미 있는 순간, 2) 1년 회고 1단락 — 함께 달성한 것 + 구체적 데이터 + 1줄 인용, 3) 우리가 배운 것 + 더 잘할 것 — 솔직 1단락, 4) 다음 1년 비전 + commit — '우리는 다음 1년 X / Y / Z 도와드리겠습니다'), '**Exec 서명**' (CEO / VP — 손 글씨 톤 + 직접 연락처).\n\n고객 / 1년 컨텍스트:\n${text}`,
  c_series_completion_announcement_ko: (text) =>
    `Write a Korean internal announcement celebrating the completion of a large multi-phase build initiative. Use 해요체. 따뜻 + 진심 + 가식 없이. Markdown: '**제목**' (1줄, 28자 이내 — '[이니셔티브] 전체 완료 — 다 함께 축하해요'), '**본문**' (4 단락: 1) 한 줄 — '오늘 우리는 [이니셔티브]를 끝까지 완성했습니다', 2) 이게 왜 의미 있는지 1단락 — 규모 / 끈기 / 팀에게 어떤 의미, 3) 호명 + 구체적 기여 — 입력에 있는 이름만, 각 '@이름 — 무엇을 한 1줄', 4) 다음 — '잠시 멈춰 자축하고, 다음 챕터로'), '**감사 (1줄)**' (모두에게).\n\n이니셔티브 + 기여자:\n${text}`,
  full_milestone_celebration_ko: (text) =>
    `Write a Korean reflective milestone celebration note for completing a major long-running effort — the kind shared at an all-hands or in a team channel. Use 해요체. 진정성 + 회고 + 겸손. Markdown: '**한 줄 (마일스톤)**' (1줄 — 무엇을 완성했는지), '**여정 회고 (1단락)**' (3-4줄 — 시작은 어땠고, 어떤 어려움을 지나, 어떻게 여기까지), '**우리가 배운 것 (3 bullets)**' (구체적 — 기술 / 협업 / 끈기), '**기여한 사람들 (1단락)**' (입력에 있는 이름만 호명), '**다음 (1줄)**' (이 마일스톤이 연 다음 가능성), '**감사 (1줄)**' (진심으로). 이모지는 절제해서 사용.\n\n마일스톤 컨텍스트:\n${text}`,
  translate_ko_to_shona: (text) =>
    `Translate the Korean text below into natural Shona (chiShona) — Bantu language of Zimbabwe and parts of Mozambique. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**chiShona**' and '**번역 노트**' (3 bullets in Korean — note Shona uses a tonal system and has rich noun-class morphology).\n\n원문:\n${text}`,
  translate_ko_to_sotho: (text) =>
    `Translate the Korean text below into natural Sesotho (Southern Sotho) — Bantu language of Lesotho and South Africa. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Sesotho**' and '**번역 노트**' (3 bullets in Korean — note Sesotho is one of the official languages of both Lesotho and South Africa).\n\n원문:\n${text}`,
  translate_ko_to_tswana: (text) =>
    `Translate the Korean text below into natural Setswana (Tswana) — Bantu language of Botswana and South Africa. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Setswana**' and '**번역 노트**' (3 bullets in Korean — note Setswana is the national language of Botswana, written with spaces between morphemes).\n\n원문:\n${text}`,
  translate_ko_to_tsonga: (text) =>
    `Translate the Korean text below into natural Xitsonga (Tsonga) — Bantu language of southern Mozambique and northeastern South Africa. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Xitsonga**' and '**번역 노트**' (3 bullets in Korean — note Xitsonga is one of South Africa's eleven official languages).\n\n원문:\n${text}`,
  translate_ko_to_venda: (text) =>
    `Translate the Korean text below into natural Tshivenda (Venda) — Bantu language of Limpopo province, South Africa, and southern Zimbabwe. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tshivenda**' and '**번역 노트**' (3 bullets in Korean — note Tshivenda is distinct from neighbouring Sotho-Tswana and Nguni languages).\n\n원문:\n${text}`,
  customer_health_score_review_ko: (text) =>
    `Produce a Korean customer health score review — a CSM's structured read on an account's health going into a check-in. Use 합쇼체. Markdown: '**한 줄 (헬스)**' (1줄 — '초록 / 노랑 / 빨강' + 핵심 이유), '**헬스 지표 (테이블)**' ('지표 | 현재 | 추세 | 코멘트'): 사용량 / 활성 사용자 / 핵심 기능 채택 / 지원 티켓 / NPS, '**잘 되는 것 (2 bullets)**', '**리스크 신호 (bullets)**' (각 '신호 — 왜 걱정 — 대응'), '**다음 액션 (테이블)**' ('액션 | 담당 | 시한'), '**갱신 전망 (1줄)**' (확률 + 근거).\n\n계정 / 데이터:\n${text}`,
  internal_incident_retro_ko: (text) =>
    `Write a Korean incident retrospective (포스트모템) — blameless, focused on system and process, not people. Use 합쇼체. Markdown: '**한 줄 요약**' (1줄 — 무슨 일이 / 영향), '**영향 (bullets)**' (누가 / 얼마나 / 얼마 동안), '**타임라인 (테이블)**' ('시각 | 사건 | 누가 인지'), '**근본 원인 (1단락)**' (5 Whys 식으로), '**잘 작동한 것 (2 bullets)**', '**아쉬웠던 것 (2 bullets)**', '**액션 아이템 (테이블)**' ('액션 | 유형(예방/탐지/완화) | 담당 | 시한'), '**재발 방지 한 줄**'. 비난 금지 — 시스템 관점.\n\n인시던트 컨텍스트:\n${text}`,
  sales_discovery_call_notes_ko: (text) =>
    `Structure Korean sales discovery call notes — turns a raw discovery call into a clean, actionable record. Use 합쇼체. Markdown: '**한 줄 (요약)**' (1줄 — 누구 / 무엇을 찾는지), '**참석자 (bullets)**' ('이름 — 역할 — 결정권 여부'), '**현재 상황 (1단락)**' (지금 어떻게 일하는지 + 페인), '**니즈 / 페인 (테이블)**' ('페인 | 영향 | 긴급도'), '**예산 / 권한 / 일정 (BANT, bullets)**', '**경쟁 / 대안 (1줄)**', '**다음 단계 (테이블)**' ('액션 | 담당 | 시한'), '**적합도 평가 (1줄)**' (좋음/보통/낮음 + 이유).\n\n콜 노트 / 원문:\n${text}`,
  product_beta_feedback_summary_ko: (text) =>
    `Summarize Korean product beta feedback — synthesizes scattered beta-tester feedback into themes a PM can act on. Use 합쇼체. Markdown: '**한 줄 (전반)**' (1줄 — 전반 반응 + 핵심 시그널), '**참여 (1줄)**' (몇 명 / 얼마나 활발), '**좋아한 것 (테이블)**' ('테마 | 빈도 | 대표 인용'), '**불만 / 막힌 점 (테이블)**' ('이슈 | 심각도 | 빈도 | 대표 인용'), '**기능 요청 (bullets)**' (빈도 순), '**의외의 인사이트 (1-2 bullets)**', '**우선순위 제안 (테이블)**' ('항목 | 영향 | 노력 | 추천'), '**GA 준비도 (1줄)**'.\n\n베타 피드백 원문:\n${text}`,
  internal_hiring_scorecard_ko: (text) =>
    `Produce a Korean interview hiring scorecard — a structured post-interview evaluation to reduce bias and force a clear recommendation. Use 합쇼체. Markdown: '**한 줄 (추천)**' (1줄 — 'Strong Yes / Yes / No / Strong No' + 핵심 이유), '**지원자 / 직무 (1줄)**', '**평가 항목 (테이블)**' ('역량 | 점수(1-4) | 근거(구체적 사례)'): 직무 역량 / 문제 해결 / 협업 / 커뮤니케이션 / 컬처 애드, '**강점 (2 bullets)**' (관찰 기반), '**우려 (bullets)**' (각 '우려 — 근거 — 확인 방법'), '**추가 검증 필요 (bullets)**', '**최종 추천 (1단락)**' (명확하게 — 애매하게 끝내지 말 것).\n\n인터뷰 노트:\n${text}`,
  translate_ko_to_ndebele: (text) =>
    `Translate the Korean text below into natural isiNdebele (Southern Ndebele) — Nguni Bantu language of Mpumalanga, South Africa. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**isiNdebele**' and '**번역 노트**' (3 bullets in Korean — note isiNdebele is one of South Africa's official Nguni languages, famous for its geometric mural art).\n\n원문:\n${text}`,
  translate_ko_to_swati: (text) =>
    `Translate the Korean text below into natural siSwati (Swazi) — Nguni Bantu language of Eswatini and South Africa. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**siSwati**' and '**번역 노트**' (3 bullets in Korean — note siSwati is the national language of Eswatini).\n\n원문:\n${text}`,
  translate_ko_to_chichewa: (text) =>
    `Translate the Korean text below into natural Chichewa (Nyanja) — Bantu language of Malawi, Zambia and Mozambique. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Chichewa**' and '**번역 노트**' (3 bullets in Korean — note Chichewa is the national language of Malawi).\n\n원문:\n${text}`,
  translate_ko_to_bemba: (text) =>
    `Translate the Korean text below into natural Bemba (Chibemba) — Bantu language widely spoken across northern Zambia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Chibemba**' and '**번역 노트**' (3 bullets in Korean — note Bemba is a major lingua franca of Zambia's Copperbelt).\n\n원문:\n${text}`,
  translate_ko_to_kinyarwanda: (text) =>
    `Translate the Korean text below into natural Kinyarwanda — Bantu language of Rwanda. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kinyarwanda**' and '**번역 노트**' (3 bullets in Korean — note Kinyarwanda is the national language of Rwanda, closely related to Kirundi).\n\n원문:\n${text}`,
  gtm_campaign_brief_ko: (text) =>
    `Write a Korean marketing campaign brief — aligns a team before launching a campaign. Use 합쇼체. Markdown: '**한 줄 (캠페인)**' (1줄 — 무엇을 / 누구에게 / 왜 지금), '**배경 (1단락)**', '**목표 (테이블)**' ('지표 | 현재 | 목표 | 기간'), '**타깃 (bullets)**' (세그먼트 + 핵심 인사이트), '**핵심 메시지 (1줄)**', '**채널 (테이블)**' ('채널 | 콘텐츠 | 담당 | 시한'), '**예산 (1줄)**', '**성공 기준 (bullets)**', '**리스크 (1-2 bullets)**'.\n\n캠페인 컨텍스트:\n${text}`,
  internal_okr_checkin_ko: (text) =>
    `Write a Korean OKR check-in — a mid-cycle status update on objectives and key results. Use 합쇼체. Markdown: '**한 줄 (전반)**' (1줄 — on track / at risk / off track), '**Objective (1줄)**', '**Key Results (테이블)**' ('KR | 목표 | 현재 | 신뢰도(%) | 상태'), '**잘 되는 것 (2 bullets)**', '**막힌 것 (bullets)**' (각 '이슈 — 필요한 도움'), '**이번 사이클 조정 (1줄)**' (목표 유지/하향/상향 + 근거), '**다음 2주 포커스 (bullets)**'.\n\nOKR 컨텍스트:\n${text}`,
  customer_churn_analysis_ko: (text) =>
    `Produce a Korean customer churn analysis — explains why an account churned and what to learn. Use 합쇼체. Markdown: '**한 줄 (이탈)**' (1줄 — 누가 / 언제 / 핵심 이유), '**계정 요약 (bullets)**' (규모 / 기간 / ARR), '**이탈 신호 타임라인 (테이블)**' ('시점 | 신호 | 우리가 인지했나'), '**근본 원인 (1단락)**', '**우리가 놓친 것 (bullets)**', '**막을 수 있었나 (1줄)**' (솔직하게), '**재발 방지 (테이블)**' ('교훈 | 액션 | 담당'), '**윈백 가능성 (1줄)**'.\n\n이탈 컨텍스트:\n${text}`,
  eng_design_doc_ko: (text) =>
    `Write a Korean engineering design doc (RFC) — proposes a technical approach for review. Use 합쇼체. Markdown: '**한 줄 (제안)**' (1줄 — 무엇을 만들/바꿀지), '**배경 / 문제 (1단락)**', '**목표 / 비목표 (bullets)**', '**제안 설계 (1-2단락)**' (핵심 아이디어 + 동작 방식), '**대안 (테이블)**' ('대안 | 장점 | 단점 | 채택 여부'), '**데이터/스키마 변경 (bullets)**' (있으면), '**롤아웃 plan (numbered)**', '**리스크 / 트레이드오프 (bullets)**', '**열린 질문 (bullets)**'.\n\n설계 컨텍스트:\n${text}`,
  internal_team_offsite_agenda_ko: (text) =>
    `Write a Korean team offsite agenda — structures a productive in-person team offsite. Use 합쇼체. Markdown: '**한 줄 (오프사이트)**' (1줄 — 목적 + 기대 결과), '**준비물 (bullets)**' (사전 읽기 / 준비), '**아젠다 (테이블)**' ('시간 | 세션 | 진행 | 목표'), '**핵심 토론 주제 (bullets)**', '**팀 빌딩 (1-2 bullets)**', '**의사결정 필요 항목 (bullets)**', '**마무리 / 액션 (1줄)**', '**로지스틱스 (1줄)**' (장소 / 식사 / 이동).\n\n오프사이트 컨텍스트:\n${text}`,
  translate_ko_to_kirundi: (text) =>
    `Translate the Korean text below into natural Kirundi (Rundi) — Bantu language of Burundi. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ikirundi**' and '**번역 노트**' (3 bullets in Korean — note Kirundi is the national language of Burundi, closely related to Kinyarwanda).\n\n원문:\n${text}`,
  translate_ko_to_luganda: (text) =>
    `Translate the Korean text below into natural Luganda (Ganda) — Bantu language of the Buganda region, central Uganda. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Luganda**' and '**번역 노트**' (3 bullets in Korean — note Luganda is the most widely spoken Ugandan language after English).\n\n원문:\n${text}`,
  translate_ko_to_kikuyu: (text) =>
    `Translate the Korean text below into natural Gikuyu (Kikuyu) — Bantu language of central Kenya. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Gĩkũyũ**' and '**번역 노트**' (3 bullets in Korean — note Gikuyu is the language of Kenya's largest ethnic group).\n\n원문:\n${text}`,
  translate_ko_to_luo: (text) =>
    `Translate the Korean text below into natural Dholuo (Luo) — Nilotic language of western Kenya and northern Tanzania. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Dholuo**' and '**번역 노트**' (3 bullets in Korean — note Dholuo is a Nilotic language, not Bantu, with a tonal system).\n\n원문:\n${text}`,
  translate_ko_to_wolof: (text) =>
    `Translate the Korean text below into natural Wolof — Senegambian language of Senegal, the Gambia and Mauritania. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Wolof**' and '**번역 노트**' (3 bullets in Korean — note Wolof is the main lingua franca of Senegal, written in Latin or Arabic script).\n\n원문:\n${text}`,
  sales_qbr_deck_outline_ko: (text) =>
    `Outline a Korean sales QBR (Quarterly Business Review) deck — slide-by-slide structure for a customer-facing quarterly review. Use 합쇼체. Markdown numbered list, each item '**슬라이드 N — 제목**' + 1줄 (그 슬라이드에 들어갈 핵심): 1) 표지 + 목적, 2) 지난 분기 요약, 3) 합의 목표 대비 성과 (테이블 톤), 4) 핵심 성과 / 가치 실현, 5) 사용 현황 / 채택, 6) 이슈 / 리스크 + 해결, 7) 로드맵 / 신규 기능, 8) 다음 분기 목표, 9) 액션 아이템, 10) Q&A / 마무리. 마지막에 '**프레젠테이션 팁 (2 bullets)**'.\n\nQBR 컨텍스트:\n${text}`,
  internal_postmortem_action_tracker_ko: (text) =>
    `Build a Korean postmortem action tracker — turns postmortem findings into a trackable action list. Use 합쇼체. Markdown: '**한 줄 (인시던트)**' (1줄), '**액션 트래커 (테이블)**' ('ID | 액션 | 유형(예방/탐지/완화/문서) | 담당 | 시한 | 상태'), '**우선순위 근거 (bullets)**' (왜 이 순서인지), '**의존성 (bullets)**' (선행 필요 항목), '**완료 정의 (bullets)**' (각 액션이 '완료'되는 기준), '**리뷰 주기 (1줄)**' (언제 다시 점검). 액션은 구체적 + 검증 가능하게.\n\n포스트모템 findings:\n${text}`,
  customer_adoption_plan_ko: (text) =>
    `Write a Korean customer adoption plan — drives a customer from onboarding to active, expanding usage. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 어떤 채택 상태를 목표로), '**현재 채택 수준 (1줄)**' (어디쯤), '**핵심 유스케이스 (테이블)**' ('유스케이스 | 가치 | 현재 채택 | 목표'), '**단계별 plan (numbered)**' (각 단계: 목표 + 활동 + 성공 기준), '**필요한 지원 (bullets)**' (교육 / 리소스 / 임원 후원), '**측정 지표 (bullets)**', '**리스크 (1-2 bullets)**', '**다음 30일 액션 (테이블)**' ('액션 | 담당 | 시한').\n\n고객 / 채택 컨텍스트:\n${text}`,
  pm_feature_spec_ko: (text) =>
    `Write a Korean PM feature spec — defines a single feature clearly enough to build. Use 합쇼체. Markdown: '**한 줄 (기능)**' (1줄 — 무엇을 / 누구를 위해), '**문제 (1단락)**' (왜 필요한지 + 근거), '**목표 / 성공 지표 (bullets)**', '**유저 스토리 (bullets)**' ('~로서 ~하고 싶다, 왜냐면 ~'), '**기능 요구사항 (numbered)**' (구체적 동작), '**비기능 요구사항 (bullets)**' (성능 / 권한 / 접근성), '**엣지 케이스 (bullets)**', '**범위 밖 (bullets)**', '**오픈 퀘스천 (bullets)**'.\n\n기능 컨텍스트:\n${text}`,
  internal_perf_review_self_ko: (text) =>
    `Write a Korean self-assessment for a performance review — an employee's reflective self-review. Use 합쇼체. 균형 (성과 + 성장 영역) + 근거 기반. Markdown: '**한 줄 (요약)**' (1줄 — 이 기간 나의 한 문장), '**핵심 성과 (bullets)**' (각 '무엇을 — 임팩트(가능하면 수치) — 내 역할'), '**잘한 점 (2 bullets)**', '**성장한 영역 (bullets)**' (작년 대비), '**아쉬운 점 / 배운 것 (bullets)**' (솔직하게), '**다음 기간 목표 (bullets)**', '**필요한 지원 (1줄)**'. 과장 없이, 구체적 사례 중심.\n\n자기평가 컨텍스트:\n${text}`,
  translate_ko_to_twi: (text) =>
    `Translate the Korean text below into natural Twi (Akan) — Kwa language of southern and central Ghana. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Twi**' and '**번역 노트**' (3 bullets in Korean — note Twi is a dialect cluster of Akan, the most widely spoken language in Ghana).\n\n원문:\n${text}`,
  translate_ko_to_ewe: (text) =>
    `Translate the Korean text below into natural Ewe (Eʋegbe) — Gbe language of southeastern Ghana and southern Togo. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Eʋegbe**' and '**번역 노트**' (3 bullets in Korean — note Ewe is a tonal Gbe language written with extended Latin letters).\n\n원문:\n${text}`,
  translate_ko_to_ga: (text) =>
    `Translate the Korean text below into natural Ga — Kwa language of the Greater Accra region, Ghana. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ga**' and '**번역 노트**' (3 bullets in Korean — note Ga is the indigenous language of Accra, Ghana's capital).\n\n원문:\n${text}`,
  translate_ko_to_fon: (text) =>
    `Translate the Korean text below into natural Fon (Fongbe) — Gbe language of Benin. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Fɔngbe**' and '**번역 노트**' (3 bullets in Korean — note Fon is the most widely spoken language of Benin, a tonal Gbe language).\n\n원문:\n${text}`,
  translate_ko_to_bambara: (text) =>
    `Translate the Korean text below into natural Bambara (Bamanankan) — Mande language of Mali. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Bamanankan**' and '**번역 노트**' (3 bullets in Korean — note Bambara is the most widely spoken language of Mali and a major Mande lingua franca).\n\n원문:\n${text}`,
  exec_business_case_ko: (text) =>
    `Write a Korean executive business case — makes the case for an investment/initiative to leadership. Use 합쇼체. 간결 + 숫자 중심. Markdown: '**한 줄 (제안)**' (1줄 — 무엇에 투자 / 왜), '**문제 / 기회 (1단락)**', '**제안 (1단락)**' (무엇을 할지 구체적), '**기대 효과 (테이블)**' ('지표 | 현재 | 예상 | 시점'), '**투자 / 비용 (bullets)**' (사람 / 돈 / 시간), '**ROI / 회수 (1줄)**', '**대안 + 안 할 경우 (bullets)**', '**리스크 + 완화 (테이블)**' ('리스크 | 영향 | 완화'), '**요청 (1줄)**' (의사결정권자에게 정확히 무엇을).\n\n비즈니스 케이스 컨텍스트:\n${text}`,
  internal_sprint_retro_ko: (text) =>
    `Facilitate a Korean sprint retrospective summary — synthesizes a sprint retro into themes and actions. Use 합쇼체. Markdown: '**한 줄 (스프린트)**' (1줄 — 전반 분위기 + 핵심), '**잘된 것 (Keep) (bullets)**', '**아쉬운 것 (Problem) (bullets)**' (각 '문제 — 영향'), '**시도할 것 (Try) (bullets)**', '**액션 아이템 (테이블)**' ('액션 | 담당 | 시한'), '**지난 retro 액션 점검 (1줄)**' (완료/미완), '**팀 건강 신호 (1줄)**' (번아웃/속도/사기). 비난 없이 개선 중심.\n\n스프린트 retro 컨텍스트:\n${text}`,
  customer_escalation_summary_ko: (text) =>
    `Write a Korean customer escalation summary — a concise brief to align internal stakeholders on a customer escalation. Use 합쇼체. 침착 + 사실 중심. Markdown: '**한 줄 (에스컬레이션)**' (1줄 — 누가 / 무엇 / 심각도), '**상황 (1단락)**' (사실만 — 시간순), '**고객 영향 (bullets)**', '**고객이 원하는 것 (1줄)**', '**현재 상태 (1줄)**', '**우리 대응 (테이블)**' ('액션 | 담당 | 상태 | 시한'), '**리스크 (bullets)**' (이탈 / 평판 / 계약), '**필요한 의사결정 (1줄)**', '**다음 업데이트 시점 (1줄)**'.\n\n에스컬레이션 컨텍스트:\n${text}`,
  pm_competitive_teardown_ko: (text) =>
    `Write a Korean competitive product teardown — a PM's structured analysis of a competitor's product. Use 합쇼체. Markdown: '**한 줄 (경쟁사)**' (1줄 — 누구 / 핵심 위협 정도), '**개요 (bullets)**' (포지셔닝 / 타깃 / 가격), '**핵심 기능 비교 (테이블)**' ('기능 | 그들 | 우리 | 우위'), '**그들이 잘하는 것 (bullets)**', '**그들의 약점 (bullets)**', '**UX / 온보딩 관찰 (bullets)**', '**우리에게 주는 시사점 (bullets)**' (방어 / 추격 / 차별화), '**액션 제안 (테이블)**' ('제안 | 우선순위 | 담당'). 근거 기반, 추측은 표시.\n\n경쟁사 / 컨텍스트:\n${text}`,
  internal_runbook_ko: (text) =>
    `Write a Korean operations runbook — a step-by-step guide for handling a recurring operational task or incident. Use 합쇼체. 명확 + 실행 가능. Markdown: '**한 줄 (런북)**' (1줄 — 이 런북이 다루는 상황), '**언제 사용 (bullets)**' (트리거 조건), '**사전 조건 (bullets)**' (권한 / 접근 / 도구), '**절차 (numbered)**' (각 단계: 명령/행동 + 기대 결과 + 확인 방법), '**검증 (bullets)**' (완료 확인), '**롤백 (numbered)**' (잘못됐을 때), '**에스컬레이션 (1줄)**' (누구에게 / 언제), '**관련 링크 (bullets)**'.\n\n런북 대상 / 컨텍스트:\n${text}`,
  translate_ko_to_dyula: (text) =>
    `Translate the Korean text below into natural Dyula (Jula) — Mande trade language of Côte d'Ivoire, Burkina Faso and Mali. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Julakan**' and '**번역 노트**' (3 bullets in Korean — note Dyula is a major West African trade lingua franca, closely related to Bambara).\n\n원문:\n${text}`,
  translate_ko_to_mossi: (text) =>
    `Translate the Korean text below into natural Mòoré (Mossi) — Gur language of Burkina Faso. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Mòoré**' and '**번역 노트**' (3 bullets in Korean — note Mòoré is the language of the Mossi people, the most widely spoken language of Burkina Faso).\n\n원문:\n${text}`,
  translate_ko_to_susu: (text) =>
    `Translate the Korean text below into natural Susu (Sosoxui) — Mande language of coastal Guinea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Sosoxui**' and '**번역 노트**' (3 bullets in Korean — note Susu is a major trade language of coastal Guinea around Conakry).\n\n원문:\n${text}`,
  translate_ko_to_krio: (text) =>
    `Translate the Korean text below into natural Krio — English-based creole of Sierra Leone. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Krio**' and '**번역 노트**' (3 bullets in Korean — note Krio is the lingua franca of Sierra Leone, an English-lexified creole).\n\n원문:\n${text}`,
  translate_ko_to_temne: (text) =>
    `Translate the Korean text below into natural Temne (Themne) — Mel language of northwestern Sierra Leone. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Temne**' and '**번역 노트**' (3 bullets in Korean — note Temne is one of the two largest indigenous languages of Sierra Leone).\n\n원문:\n${text}`,
  internal_decision_record_adr_ko: (text) =>
    `Write a Korean Architecture Decision Record (ADR) — captures a single technical/architectural decision and its rationale. Use 합쇼체. Markdown: '**제목 (ADR-NNN)**' (1줄 — 결정 요지), '**상태 (1줄)**' (제안 / 승인 / 폐기 / 대체됨), '**맥락 (1단락)**' (어떤 상황/제약에서 이 결정이 필요했나), '**결정 (1단락)**' ('우리는 ~하기로 한다' — 명확히), '**고려한 대안 (테이블)**' ('대안 | 장점 | 단점 | 기각 이유'), '**결과 (bullets)**' (긍정 + 부정 + 따라오는 후속 작업), '**관련 결정 (1줄)**'. 중립적 + 사실 기반.\n\n결정 컨텍스트:\n${text}`,
  sales_mutual_action_plan_ko: (text) =>
    `Write a Korean Mutual Action Plan (MAP) — a shared buyer-seller plan to reach a deal close date. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 무엇을 / 언제까지), '**최종 목표 일자 (1줄)**', '**마일스톤 (테이블)**' ('단계 | 활동 | 우리 담당 | 고객 담당 | 시한 | 상태'), '**의사결정 기준 (bullets)**' (고객이 사려면 충족돼야 할 것), '**필요 리소스 (bullets)**', '**리스크 / 블로커 (bullets)**', '**다음 미팅 (1줄)**', '**공동 합의 (1줄)**' (양측이 동의한 다음 액션). 협업 톤 — 고객과 공유 가능하게.\n\n딜 컨텍스트:\n${text}`,
  customer_value_realization_ko: (text) =>
    `Write a Korean value realization summary — proves the value a customer has gotten, for a renewal or exec review. Use 합쇼체. 데이터 중심 + 고객 언어. Markdown: '**한 줄 (가치)**' (1줄 — 핵심 성과 한 문장), '**도입 목표 vs 실현 (테이블)**' ('목표 | 결과 | 달성도'), '**정량 효과 (bullets)**' (시간 절감 / 비용 / 매출 — 수치 + 출처), '**정성 효과 (bullets)**' (워크플로우 / 만족 / 인용), '**ROI 추정 (1줄)**', '**미실현 가치 (bullets)**' (아직 안 쓰는 기능 → 기회), '**다음 단계 (1줄)**'.\n\n가치 / 데이터 컨텍스트:\n${text}`,
  pm_user_journey_map_ko: (text) =>
    `Build a Korean user journey map — maps a user's end-to-end experience to find pain and opportunity. Use 합쇼체. Markdown: '**한 줄 (여정)**' (1줄 — 누구의 / 무슨 여정), '**페르소나 (1줄)**', '**단계별 여정 (테이블)**' ('단계 | 사용자 행동 | 생각/감정 | 페인 | 기회'), '**감정 곡선 (1줄)**' (어디서 최고/최저), '**핵심 페인 Top 3 (bullets)**', '**기회 Top 3 (bullets)**' (각 '기회 — 예상 임팩트'), '**다음 액션 (테이블)**' ('액션 | 담당 | 우선순위'). 추측은 가설로 표시.\n\n여정 컨텍스트:\n${text}`,
  internal_capacity_planning_ko: (text) =>
    `Write a Korean team capacity planning doc — plans whether the team can take on upcoming work. Use 합쇼체. Markdown: '**한 줄 (결론)**' (1줄 — 수용 가능 / 빠듯 / 불가 + 이유), '**가용 캐파 (테이블)**' ('인원 | 역할 | 가용%(휴가/온콜 반영) | 환산 인일'), '**예정 작업 (테이블)**' ('작업 | 추정 공수 | 우선순위 | 의존성'), '**캐파 vs 수요 (1줄)**' (총 가용 vs 총 필요), '**병목 (bullets)**', '**시나리오 (bullets)**' (다 하면 / 우선순위만 / 충원 시), '**권고 (1단락)**' (무엇을 빼거나 미루거나 충원할지).\n\n캐파 컨텍스트:\n${text}`,
  translate_ko_to_tigre: (text) =>
    `Translate the Korean text below into natural Tigre (Tigrayit) — Ethiopic Semitic language of the Eritrean lowlands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tigre**' and '**번역 노트**' (3 bullets in Korean — note Tigre is a North Ethiopic Semitic language, distinct from Tigrinya).\n\n원문:\n${text}`,
  translate_ko_to_afar: (text) =>
    `Translate the Korean text below into natural Afar (Qafar af) — Cushitic language of Djibouti, Eritrea and Ethiopia's Afar region. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Qafar af**' and '**번역 노트**' (3 bullets in Korean — note Afar is an East Cushitic language of the Afar Triangle).\n\n원문:\n${text}`,
  translate_ko_to_saho: (text) =>
    `Translate the Korean text below into natural Saho — Cushitic language of Eritrea and northern Ethiopia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Saho**' and '**번역 노트**' (3 bullets in Korean — note Saho is an East Cushitic language closely related to Afar).\n\n원문:\n${text}`,
  translate_ko_to_beja: (text) =>
    `Translate the Korean text below into natural Beja (Bidhaawyeet) — Cushitic language of eastern Sudan, Eritrea and Egypt. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Bidhaawyeet**' and '**번역 노트**' (3 bullets in Korean — note Beja is the northernmost Cushitic language, spoken along the Red Sea coast).\n\n원문:\n${text}`,
  translate_ko_to_nuer: (text) =>
    `Translate the Korean text below into natural Nuer (Thok Naath) — Nilotic language of South Sudan and western Ethiopia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Thok Naath**' and '**번역 노트**' (3 bullets in Korean — note Nuer is a Western Nilotic language with a complex vowel system).\n\n원문:\n${text}`,
  internal_weekly_status_ko: (text) =>
    `Write a Korean weekly status update — a concise team/project status for stakeholders. Use 합쇼체. 짧고 스캔 가능하게. Markdown: '**한 줄 (상태)**' (1줄 — 🟢/🟡/🔴 + 핵심), '**이번 주 한 것 (bullets)**' (결과 중심), '**다음 주 할 것 (bullets)**', '**막힌 것 / 도움 필요 (bullets)**' (각 '무엇 — 누구에게 무엇을'), '**지표 (1줄)**' (핵심 숫자), '**리스크 (1줄)**' (있으면). 군더더기 없이.\n\n주간 컨텍스트:\n${text}`,
  sales_proposal_exec_summary_ko: (text) =>
    `Write a Korean proposal executive summary — the opening 1-page summary of a sales proposal. Use 합쇼체. 고객 언어 + 가치 중심. Markdown: '**한 줄 (제안)**' (1줄 — 고객에게 무엇을 / 어떤 가치), '**고객 상황 이해 (1단락)**' (그들의 목표/페인을 우리가 안다는 것), '**제안 솔루션 (1단락)**', '**기대 효과 (bullets)**' (정량 + 정성), '**왜 우리인가 (2 bullets)**', '**투자 개요 (1줄)**', '**다음 단계 (1줄)**'. 신뢰 + 간결.\n\n제안 컨텍스트:\n${text}`,
  customer_success_plan_ko: (text) =>
    `Write a Korean customer success plan — a forward-looking plan to ensure a customer achieves their goals. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 고객의 비즈니스 목표), '**성공 정의 (bullets)**' (고객이 '성공'이라 부를 구체적 상태), '**현재 vs 목표 (테이블)**' ('영역 | 현재 | 목표'), '**플레이북 (테이블)**' ('이니셔티브 | 목표 | 활동 | 담당 | 시한'), '**리스크 (bullets)**' (각 '리스크 — 완화'), '**거버넌스 (1줄)**' (정기 점검 주기), '**성공 지표 (bullets)**'.\n\n고객 성공 컨텍스트:\n${text}`,
  pm_release_notes_external_ko: (text) =>
    `Write Korean external release notes — customer-facing notes announcing what shipped. Use 해요체 (친근 + 명확). Markdown: '**한 줄 (이번 릴리스)**' (1줄 — 가장 큰 변화), '**새로운 기능 (bullets)**' (각 '**기능명** — 무엇을 / 사용자에게 어떤 이점' — 기능 위주, 내부 용어 금지), '**개선 (bullets)**', '**버그 수정 (bullets)**' (간결하게), '**알아두면 좋은 점 (1-2 bullets)**' (마이그레이션/주의), '**피드백 (1줄)**' (어디로). 친근하지만 과장 없이.\n\n릴리스 컨텍스트:\n${text}`,
  internal_meeting_notes_ko: (text) =>
    `Structure Korean meeting notes — turns raw meeting discussion into clean, actionable notes. Use 합쇼체. Markdown: '**한 줄 (회의)**' (1줄 — 목적 + 결론), '**참석자 (1줄)**', '**논의 요약 (bullets)**' (주제별 핵심), '**결정 사항 (bullets)**' (명확히 — '~하기로 함'), '**액션 아이템 (테이블)**' ('액션 | 담당 | 시한'), '**미해결 / 다음 논의 (bullets)**', '**다음 회의 (1줄)**' (있으면). 사실 중심, 누가 무슨 의견인지 필요한 경우만.\n\n회의 원문:\n${text}`,
  translate_ko_to_dinka: (text) =>
    `Translate the Korean text below into natural Dinka (Thuɔŋjäŋ) — Nilotic language of South Sudan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Thuɔŋjäŋ**' and '**번역 노트**' (3 bullets in Korean — note Dinka is the most widely spoken language of South Sudan, a Western Nilotic language).\n\n원문:\n${text}`,
  translate_ko_to_kanuri: (text) =>
    `Translate the Korean text below into natural Kanuri — Nilo-Saharan language of northeastern Nigeria, Niger and Chad. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kanuri**' and '**번역 노트**' (3 bullets in Korean — note Kanuri is the language of the historic Kanem-Bornu empire around Lake Chad).\n\n원문:\n${text}`,
  translate_ko_to_zarma: (text) =>
    `Translate the Korean text below into natural Zarma (Zarmaciine) — Songhay language of southwestern Niger. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Zarmaciine**' and '**번역 노트**' (3 bullets in Korean — note Zarma is the most widely spoken language of Niger after Hausa).\n\n원문:\n${text}`,
  translate_ko_to_maasai: (text) =>
    `Translate the Korean text below into natural Maa (Maasai) — Nilotic language of southern Kenya and northern Tanzania. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Maa**' and '**번역 노트**' (3 bullets in Korean — note Maa is an Eastern Nilotic language of the pastoralist Maasai people).\n\n원문:\n${text}`,
  translate_ko_to_turkana: (text) =>
    `Translate the Korean text below into natural Turkana (Ŋaturkana) — Nilotic language of northwestern Kenya. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ŋaturkana**' and '**번역 노트**' (3 bullets in Korean — note Turkana is an Eastern Nilotic language closely related to Maa).\n\n원문:\n${text}`,
  internal_tech_spike_summary_ko: (text) =>
    `Write a Korean technical spike summary — reports the findings of a time-boxed investigation (spike). Use 합쇼체. Markdown: '**한 줄 (결론)**' (1줄 — 무엇을 알아냈고 권고는), '**스파이크 질문 (1줄)**' (무엇을 검증하려 했나), '**조사한 것 (bullets)**' (시도/실험), '**발견 (bullets)**' (사실 + 근거), '**옵션 비교 (테이블)**' ('옵션 | 장점 | 단점 | 리스크'), '**권고 (1단락)**' (무엇을 / 왜), '**남은 불확실성 (bullets)**', '**다음 단계 (1줄)**'. 사실과 의견을 구분.\n\n스파이크 컨텍스트:\n${text}`,
  sales_cold_outreach_sequence_ko: (text) =>
    `Write a Korean cold outreach email sequence — a 3-email sequence for prospecting a new account. Use 합쇼체 (정중 + 간결, 스팸 같지 않게). Markdown: '**시퀀스 목표 (1줄)**', '**이메일 1 — 첫 접촉**' ('제목:' 1줄 + 본문 4-5줄: 개인화 1줄 + 가치 가설 + 가벼운 CTA), '**이메일 2 — 팔로업 (3일 후)**' (다른 각도 + 사회적 증거 1줄), '**이메일 3 — 브레이크업 (5일 후)**' (짧게, 마지막, 부담 없이), '**팁 (2 bullets)**' (개인화 / 타이밍). 각 이메일 80단어 이내.\n\n프로스펙트 / 컨텍스트:\n${text}`,
  customer_renewal_followup_email_ko: (text) =>
    `Draft a Korean renewal follow-up email — sent after a renewal conversation to keep momentum. Use 합쇼체 (따뜻 + 명확). Markdown: '**제목**' (1줄), '**본문**' (3-4 단락: 1) 대화 감사 + 핵심 1줄 요약, 2) 합의/논의한 가치 다시 짚기 + 데이터 1줄, 3) 다음 단계 명확히 — 무엇을 / 언제까지 / 누가, 4) 가벼운 마무리 + 도움 제안), '**첨부/링크 제안 (1줄)**' (있으면). 압박 없이 신뢰 톤.\n\n갱신 대화 컨텍스트:\n${text}`,
  pm_prioritization_rice_ko: (text) =>
    `Produce a Korean RICE prioritization analysis — scores and ranks initiatives by Reach, Impact, Confidence, Effort. Use 합쇼체. Markdown: '**한 줄 (추천)**' (1줄 — 무엇을 먼저), '**RICE 점수 (테이블)**' ('항목 | Reach | Impact | Confidence(%) | Effort(인월) | RICE 점수'), '**점수 산정 노트 (bullets)**' (각 항목 가정 근거), '**우선순위 결과 (numbered)**' (점수 순 + 1줄 코멘트), '**주의 (bullets)**' (점수의 한계 / 전략적 예외), '**다음 액션 (1줄)**'. RICE = (Reach×Impact×Confidence)/Effort.\n\n이니셔티브 목록:\n${text}`,
  internal_onboarding_buddy_guide_ko: (text) =>
    `Write a Korean onboarding buddy guide — helps a buddy support a new hire's first weeks. Use 해요체 (친근 + 실용). Markdown: '**한 줄 (역할)**' (1줄 — 버디로서 무엇을), '**첫날 (bullets)**' (환영 / 소개 / 점심), '**첫 주 (bullets)**' (체크인 / 셋업 / 문화), '**첫 30일 (bullets)**' (점진적 깊이), '**정기 체크인 질문 (bullets)**' ('이번 주 막힌 거 있어요?' 류), '**소개해줄 사람 (bullets)**', '**하지 말 것 (1-2 bullets)**' (압도 금지 등), '**에스컬레이션 (1줄)**' (걱정되면 누구에게).\n\n온보딩 컨텍스트:\n${text}`,
  translate_ko_to_lingala: (text) =>
    `Translate the Korean text below into natural Lingala (Lingála) — Bantu language of the Congo River region, DR Congo and Republic of the Congo. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Lingála**' and '**번역 노트**' (3 bullets in Korean — note Lingala is a major lingua franca of the Congos and Congolese music).\n\n원문:\n${text}`,
  translate_ko_to_kongo: (text) =>
    `Translate the Korean text below into natural Kikongo (Kongo) — Bantu language of the lower Congo region. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kikongo**' and '**번역 노트**' (3 bullets in Korean — note Kikongo is the historic language of the Kingdom of Kongo, spoken across Angola, DR Congo and Congo).\n\n원문:\n${text}`,
  translate_ko_to_tshiluba: (text) =>
    `Translate the Korean text below into natural Tshiluba (Luba-Kasai) — Bantu language of the Kasai region, DR Congo. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tshiluba**' and '**번역 노트**' (3 bullets in Korean — note Tshiluba is one of the four national languages of DR Congo).\n\n원문:\n${text}`,
  translate_ko_to_sango: (text) =>
    `Translate the Korean text below into natural Sango (Sängö) — Ngbandi-based creole and national language of the Central African Republic. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Sängö**' and '**번역 노트**' (3 bullets in Korean — note Sango is the national lingua franca of the Central African Republic).\n\n원문:\n${text}`,
  translate_ko_to_mongo: (text) =>
    `Translate the Korean text below into natural Mongo (Lomongo) — Bantu language of the central Congo basin, DR Congo. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Lomongo**' and '**번역 노트**' (3 bullets in Korean — note Mongo is spoken across the equatorial rainforest of central DR Congo).\n\n원문:\n${text}`,
  internal_kickoff_doc_ko: (text) =>
    `Write a Korean project kickoff doc — aligns a team at the start of a project. Use 합쇼체. Markdown: '**한 줄 (프로젝트)**' (1줄 — 무엇을 / 왜 / 언제까지), '**배경 (1단락)**' (왜 지금 이걸), '**목표 / 성공 기준 (bullets)**', '**범위 / 비범위 (bullets)**', '**팀 / 역할 (테이블)**' ('이름 | 역할 | 책임'), '**마일스톤 (테이블)**' ('마일스톤 | 산출물 | 시한'), '**리스크 / 가정 (bullets)**', '**커뮤니케이션 (1줄)**' (어디서 / 얼마나 자주), '**다음 액션 (테이블)**' ('액션 | 담당 | 시한').\n\n프로젝트 컨텍스트:\n${text}`,
  sales_battlecard_ko: (text) =>
    `Write a Korean sales battlecard — a quick-reference card for reps to win against a competitor. Use 합쇼체. 스캔 가능 + 실전형. Markdown: '**경쟁사 (1줄)**' (한 줄 포지셔닝), '**한 줄 우리 포지션 (1줄)**' (그들 대비 우리), '**우리가 이기는 지점 (bullets)**' (각 '강점 — 증거'), '**그들이 이기는 지점 + 대응 (테이블)**' ('그들 강점 | 우리 대응 멘트'), '**랜드마인 질문 (bullets)**' (고객이 그들에게 물으면 불리해지는 질문), '**대표 반론 처리 (테이블)**' ('고객 우려 | 응답'), '**금지 멘트 (1-2 bullets)**' (하면 안 되는 말).\n\n경쟁사 / 컨텍스트:\n${text}`,
  customer_exec_business_review_ebr_ko: (text) =>
    `Outline a Korean Executive Business Review (EBR) — a strategic, exec-level review (higher altitude than a QBR). Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**비즈니스 성과 (테이블)**' ('고객 비즈니스 목표 | 우리 기여 | 결과'), '**전략적 정렬 (1단락)**' (우리 로드맵 ↔ 고객 전략), '**가치 요약 (bullets)**' (임원이 들을 한 줄들), '**리스크 / 기회 (테이블)**' ('항목 | 영향 | 제안'), '**다음 6-12개월 공동 비전 (bullets)**', '**임원 요청 (1줄)**' (스폰서십 / 확장 / 레퍼런스), '**액션 (테이블)**'. C레벨 톤.\n\nEBR 컨텍스트:\n${text}`,
  pm_experiment_design_ko: (text) =>
    `Write a Korean A/B experiment design — defines a rigorous product experiment. Use 합쇼체. Markdown: '**한 줄 (실험)**' (1줄 — 무엇을 검증), '**가설 (1줄)**' ('만약 ~하면 ~할 것이다, 왜냐면 ~'), '**지표 (bullets)**' (primary 1개 + guardrail 2-3개), '**변형 (테이블)**' ('그룹 | 처리 | 비율'), '**대상 / 분할 (1줄)**', '**표본 크기 / 기간 (1줄)**' (MDE + 가정), '**분석 방법 (1줄)**', '**의사결정 규칙 (bullets)**' ('이기면 ~, 지면 ~, 무의미하면 ~'), '**리스크 (bullets)**'.\n\n실험 컨텍스트:\n${text}`,
  internal_oncall_handoff_ko: (text) =>
    `Write a Korean on-call handoff note — hands off context at the end of an on-call shift. Use 합쇼체. 간결 + 실행 가능. Markdown: '**한 줄 (교대)**' (1줄 — 전반 상태 🟢/🟡/🔴), '**진행 중 이슈 (테이블)**' ('이슈 | 심각도 | 현재 상태 | 다음 액션'), '**주의 깊게 볼 것 (bullets)**' (불안정 신호 / 재발 가능), '**최근 변경 (bullets)**' (배포 / 설정), '**침묵시킨 알림 (bullets)**' (있으면 — 왜 / 언제 풀지), '**유용한 링크 (bullets)**' (대시보드 / 런북), '**인계 확인 (1줄)**'.\n\n온콜 컨텍스트:\n${text}`,
  translate_ko_to_herero: (text) =>
    `Translate the Korean text below into natural Otjiherero (Herero) — Bantu language of Namibia and Botswana. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Otjiherero**' and '**번역 노트**' (3 bullets in Korean — note Otjiherero is spoken by the Herero people of Namibia).\n\n원문:\n${text}`,
  translate_ko_to_nama: (text) =>
    `Translate the Korean text below into natural Khoekhoe (Nama/Damara) — a Khoe language of Namibia with click consonants. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Khoekhoegowab**' and '**번역 노트**' (3 bullets in Korean — note Nama is a Khoisan-family language famous for its click consonants, written with special characters).\n\n원문:\n${text}`,
  translate_ko_to_oshiwambo: (text) =>
    `Translate the Korean text below into natural Oshiwambo (Ovambo) — Bantu language of northern Namibia and southern Angola. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Oshiwambo**' and '**번역 노트**' (3 bullets in Korean — note Oshiwambo is the most widely spoken first language in Namibia).\n\n원문:\n${text}`,
  translate_ko_to_lozi: (text) =>
    `Translate the Korean text below into natural Lozi (Silozi) — Bantu language of western Zambia and the Caprivi Strip. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Silozi**' and '**번역 노트**' (3 bullets in Korean — note Lozi is a Sotho-related language carried north by the Kololo migration).\n\n원문:\n${text}`,
  translate_ko_to_tonga_zambia: (text) =>
    `Translate the Korean text below into natural Tonga (Chitonga) — Bantu language of southern Zambia and Zimbabwe. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Chitonga**' and '**번역 노트**' (3 bullets in Korean — note this is Zambian/Zimbabwean Tonga, distinct from Malawian Tonga and Tongan).\n\n원문:\n${text}`,
  internal_change_management_plan_ko: (text) =>
    `Write a Korean change management plan — manages the people side of a significant change rollout. Use 합쇼체. Markdown: '**한 줄 (변화)**' (1줄 — 무엇이 / 누구에게 바뀌나), '**왜 (1단락)**' (변화의 이유 + 안 하면), '**영향받는 그룹 (테이블)**' ('그룹 | 무엇이 바뀜 | 우려 | 필요 지원'), '**커뮤니케이션 plan (테이블)**' ('대상 | 메시지 | 채널 | 시점'), '**교육 / 지원 (bullets)**', '**저항 대응 (bullets)**' (예상 반발 + 대응), '**성공 지표 (bullets)**' (채택률 등), '**타임라인 (1줄)**', '**롤백 / 컨틴전시 (1줄)**'.\n\n변화 컨텍스트:\n${text}`,
  sales_renewal_risk_assessment_ko: (text) =>
    `Write a Korean renewal risk assessment — evaluates the risk of an upcoming renewal and what to do. Use 합쇼체. Markdown: '**한 줄 (리스크)**' (1줄 — 높음/중간/낮음 + 갱신 확률%), '**계정 요약 (bullets)**' (ARR / 갱신일 / 기간), '**리스크 요인 (테이블)**' ('요인 | 신호 | 가중치'): 사용량 / 챔피언 / 가치 실현 / 지원 / 예산, '**긍정 신호 (bullets)**', '**핵심 우려 (1단락)**', '**완화 액션 (테이블)**' ('액션 | 담당 | 시한'), '**필요 자원 (bullets)**' (임원 후원 등), '**최악 시나리오 대비 (1줄)**'.\n\n갱신 컨텍스트:\n${text}`,
  customer_training_plan_ko: (text) =>
    `Write a Korean customer training plan — plans how to train a customer's team on the product. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 누가 무엇을 할 수 있게), '**대상 그룹 (테이블)**' ('그룹 | 역할 | 현재 수준 | 목표 수준'), '**커리큘럼 (테이블)**' ('세션 | 주제 | 형식 | 시간 | 대상'), '**전달 방식 (bullets)**' (라이브 / 녹화 / 문서 / 핸즈온), '**일정 (1줄)**', '**자료 / 준비물 (bullets)**', '**완료 / 숙련 측정 (bullets)**', '**지속 학습 (1줄)**' (이후 어떻게 유지).\n\n교육 컨텍스트:\n${text}`,
  pm_north_star_metric_ko: (text) =>
    `Write a Korean North Star metric definition — defines and justifies a product's single guiding metric. Use 합쇼체. Markdown: '**한 줄 (노스스타)**' (1줄 — 지표 한 문장), '**왜 이 지표 (1단락)**' (고객 가치 ↔ 비즈니스 연결), '**정의 (bullets)**' (정확한 계산식 + 포함/제외), '**입력 지표 (테이블)**' ('인풋 지표 | 노스스타에 미치는 영향 | 누가 영향'), '**현재 값 / 목표 (1줄)**', '**안티-게이밍 가드레일 (bullets)**' (이 지표만 좇으면 안 되는 이유 + 보호 지표), '**리뷰 주기 (1줄)**'.\n\n제품 / 컨텍스트:\n${text}`,
  internal_quarterly_planning_ko: (text) =>
    `Write a Korean quarterly planning doc — sets a team's priorities and goals for the quarter. Use 합쇼체. Markdown: '**한 줄 (분기 테마)**' (1줄), '**지난 분기 회고 (bullets)**' (달성 / 미달 / 교훈), '**이번 분기 목표 (테이블)**' ('목표 | 핵심 결과 | 담당'), '**우선순위 (numbered)**' (P0 / P1 / P2 + 근거), '**의도적으로 안 할 것 (bullets)**', '**리소스 / 캐파 (1줄)**', '**의존성 / 리스크 (bullets)**', '**측정 / 체크인 (1줄)**' (언제 점검). 집중과 트레이드오프 강조.\n\n분기 컨텍스트:\n${text}`,
  translate_ko_to_kalanga: (text) =>
    `Translate the Korean text below into natural Kalanga (TjiKalanga) — Bantu language of southwestern Zimbabwe and northeastern Botswana. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**TjiKalanga**' and '**번역 노트**' (3 bullets in Korean — note Kalanga is related to Shona but distinct, spoken across the Zimbabwe-Botswana border).\n\n원문:\n${text}`,
  translate_ko_to_ndau: (text) =>
    `Translate the Korean text below into natural Ndau (ChiNdau) — Bantu language of eastern Zimbabwe and central Mozambique. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ChiNdau**' and '**번역 노트**' (3 bullets in Korean — note Ndau is part of the Shona language cluster spoken near the Mozambique border).\n\n원문:\n${text}`,
  translate_ko_to_manyika: (text) =>
    `Translate the Korean text below into natural Manyika (ChiManyika) — a Shona dialect of eastern Zimbabwe and Manica province, Mozambique. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ChiManyika**' and '**번역 노트**' (3 bullets in Korean — note Manyika is a Shona variety of the eastern highlands).\n\n원문:\n${text}`,
  translate_ko_to_sena: (text) =>
    `Translate the Korean text below into natural Sena (ChiSena) — Bantu language of the lower Zambezi valley in Mozambique and Malawi. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ChiSena**' and '**번역 노트**' (3 bullets in Korean — note Sena is spoken along the lower Zambezi River).\n\n원문:\n${text}`,
  translate_ko_to_chopi: (text) =>
    `Translate the Korean text below into natural Chopi (Cicopi) — Bantu language of the coastal Inhambane province, Mozambique. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Cicopi**' and '**번역 노트**' (3 bullets in Korean — note Chopi people are renowned for their timbila xylophone music tradition).\n\n원문:\n${text}`,
  internal_design_critique_notes_ko: (text) =>
    `Structure Korean design critique notes — captures structured feedback from a design critique session. Use 합쇼체. Markdown: '**한 줄 (무엇을 리뷰)**' (1줄), '**디자인 목표 (1줄)**' (이 디자인이 풀려는 것), '**잘된 점 (bullets)**', '**개선 피드백 (테이블)**' ('영역 | 피드백 | 심각도(blocker/major/minor) | 제안'), '**열린 질문 (bullets)**', '**의사결정 (bullets)**' (이 자리에서 정한 것), '**액션 아이템 (테이블)**' ('액션 | 담당 | 시한'), '**다음 리뷰 (1줄)**'. 사람이 아닌 작업에 대한 피드백으로.\n\n크리틱 컨텍스트:\n${text}`,
  sales_account_plan_ko: (text) =>
    `Write a Korean strategic account plan — a plan to grow and retain a key account. Use 합쇼체. Markdown: '**한 줄 (계정 전략)**' (1줄), '**계정 개요 (bullets)**' (산업 / 규모 / 현재 ARR / 갱신), '**관계 맵 (테이블)**' ('이름 | 역할 | 영향력 | 우리 관계 강도'), '**고객 목표 (bullets)**' (그들의 비즈니스 우선순위), '**성장 기회 (테이블)**' ('기회 | 가치 | 가능성 | 다음 액션'), '**리스크 (bullets)**', '**12개월 목표 (bullets)**', '**90일 액션 (테이블)**' ('액션 | 담당 | 시한').\n\n계정 컨텍스트:\n${text}`,
  customer_voice_of_customer_ko: (text) =>
    `Synthesize a Korean Voice of the Customer (VoC) report — turns customer feedback across sources into themes for the org. Use 합쇼체. Markdown: '**한 줄 (핵심 시그널)**' (1줄), '**데이터 출처 (bullets)**' (설문 / 인터뷰 / 지원 / 리뷰 — 표본), '**핵심 테마 (테이블)**' ('테마 | 빈도 | 감정 | 대표 인용'), '**가장 큰 불만 (bullets)**', '**가장 큰 칭찬 (bullets)**', '**세그먼트별 차이 (bullets)**' (있으면), '**시사점 (bullets)**' (제품 / CS / 마케팅), '**권고 액션 (테이블)**' ('액션 | 담당 | 우선순위'). 인용은 고객 언어 그대로.\n\nVoC 원자료:\n${text}`,
  pm_gtm_launch_plan_ko: (text) =>
    `Write a Korean go-to-market launch plan — coordinates a cross-functional product launch. Use 합쇼체. Markdown: '**한 줄 (런치)**' (1줄 — 무엇을 / 언제 / 누구에게), '**런치 목표 (테이블)**' ('지표 | 목표 | 기간'), '**타깃 / 메시지 (bullets)**', '**런치 티어 (1줄)**' (T1/T2/T3 규모), '**기능별 준비 (테이블)**' ('팀 | 산출물 | 상태 | 담당'): Product / Marketing / Sales / Support / Docs, '**타임라인 (테이블)**' ('단계 | 날짜 | 게이트'), '**리스크 (bullets)**', '**Go/No-go 기준 (bullets)**', '**런치 후 측정 (bullets)**'.\n\n런치 컨텍스트:\n${text}`,
  internal_skip_level_prep_ko: (text) =>
    `Help prepare for a Korean skip-level meeting — helps an IC or manager prepare for a skip-level 1:1 with a senior leader. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄 — 이 미팅에서 얻고 싶은 것), '**나/팀 현황 요약 (bullets)**' (간결 — 무엇을 하고 있나), '**자랑할 것 (bullets)**' (가시성 필요한 성과), '**솔직히 공유할 어려움 (bullets)**' (도움 필요한 것), '**물어볼 질문 (bullets)**' (전략 / 우선순위 / 커리어), '**피드백 줄 것 (1-2 bullets)**' (위로 향하는 건설적 피드백), '**하지 말 것 (1줄)**' (직속 상사 험담 등). 솔직 + 프로페셔널.\n\n스킵레벨 컨텍스트:\n${text}`,
  translate_ko_to_enga: (text) =>
    `Translate the Korean text below into natural Enga — Engan language of the Enga Province, highlands of Papua New Guinea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Enga**' and '**번역 노트**' (3 bullets in Korean — note Enga is one of the largest indigenous languages of Papua New Guinea by speakers).\n\n원문:\n${text}`,
  translate_ko_to_huli: (text) =>
    `Translate the Korean text below into natural Huli — language of the Hela Province, southern highlands of Papua New Guinea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Huli**' and '**번역 노트**' (3 bullets in Korean — note Huli has an unusual base-15 numeral system).\n\n원문:\n${text}`,
  translate_ko_to_tolai: (text) =>
    `Translate the Korean text below into natural Tolai (Kuanua) — Austronesian language of East New Britain, Papua New Guinea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kuanua**' and '**번역 노트**' (3 bullets in Korean — note Tolai is an Oceanic language and traditional shell money (tabu) is central to its culture).\n\n원문:\n${text}`,
  translate_ko_to_kuman: (text) =>
    `Translate the Korean text below into natural Kuman — Chimbu language of the Simbu Province, Papua New Guinea highlands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kuman**' and '**번역 노트**' (3 bullets in Korean — note Kuman is a Trans-New Guinea language of the central highlands).\n\n원문:\n${text}`,
  translate_ko_to_melpa: (text) =>
    `Translate the Korean text below into natural Melpa — language of the Western Highlands around Mount Hagen, Papua New Guinea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Melpa**' and '**번역 노트**' (3 bullets in Korean — note Melpa is known from the moka ceremonial gift-exchange system).\n\n원문:\n${text}`,
  internal_brainstorm_summary_ko: (text) =>
    `Summarize a Korean brainstorm session — turns a messy brainstorm into organized, actionable output. Use 합쇼체. Markdown: '**한 줄 (주제)**' (1줄 — 무엇을 brainstorm), '**아이디어 클러스터 (테이블)**' ('테마 | 아이디어들 | 유망도'), '**탑 아이디어 (numbered)**' (각 '아이디어 — 왜 유망 — 다음 검증'), '**와일드카드 (bullets)**' (엉뚱하지만 흥미로운), '**제외 / 보류 (bullets)**' (이유 1줄), '**열린 질문 (bullets)**', '**다음 액션 (테이블)**' ('액션 | 담당 | 시한'). 판단보다 가능성 포착 우선.\n\n브레인스토밍 원자료:\n${text}`,
  sales_win_loss_analysis_ko: (text) =>
    `Write a Korean win/loss analysis — learns why a deal was won or lost. Use 합쇼체. Markdown: '**한 줄 (결과)**' (1줄 — 승/패 + 핵심 이유), '**딜 요약 (bullets)**' (규모 / 경쟁 / 기간), '**결정 요인 (테이블)**' ('요인 | 우리에게 유리/불리 | 근거'): 제품 / 가격 / 관계 / 타이밍 / 프로세스, '**고객이 말한 이유 (bullets)**' (그들의 언어로), '**우리가 잘한 것 (bullets)**', '**놓친 것 (bullets)**', '**교훈 (bullets)**' (반복 가능한), '**프로세스 개선 제안 (테이블)**' ('제안 | 담당').\n\n딜 컨텍스트:\n${text}`,
  customer_qbr_prep_internal_ko: (text) =>
    `Write a Korean internal QBR prep doc — the team's internal prep before a customer QBR. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 이 QBR에서 이루고 싶은 것), '**계정 상태 (bullets)**' (헬스 / ARR / 갱신일), '**우리가 보여줄 가치 (bullets)**' (데이터 + 스토리), '**고객 우려 예상 (테이블)**' ('우려 | 우리 답변'), '**물어볼 질문 (bullets)**' (확장 / 전략 단서), '**리스크 (bullets)**', '**원하는 결과 / 액션 (1줄)**', '**역할 분담 (테이블)**' ('누가 | 어느 파트'). 고객 앞에서가 아닌 내부 솔직 버전.\n\nQBR 컨텍스트:\n${text}`,
  pm_feature_flag_rollout_ko: (text) =>
    `Write a Korean feature flag rollout plan — plans a safe, staged rollout behind a feature flag. Use 합쇼체. Markdown: '**한 줄 (롤아웃)**' (1줄 — 무슨 기능 / 어떻게 단계적으로), '**플래그 정보 (bullets)**' (이름 / 기본값 / 소유), '**단계 (테이블)**' ('단계 | 대상(% 또는 그룹) | 기간 | 진입 기준'), '**모니터링 지표 (bullets)**' (성공 + 가드레일), '**자동 롤백 조건 (bullets)**', '**수동 점검 (bullets)**', '**완전 출시 기준 (1줄)**', '**플래그 정리 (1줄)**' (언제 제거). 안전 우선.\n\n기능 / 롤아웃 컨텍스트:\n${text}`,
  internal_doc_style_guide_ko: (text) =>
    `Write a Korean documentation style guide — sets writing conventions for a team's docs. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**원칙 (bullets)**' (명확 / 간결 / 독자 우선), '**문체 (bullets)**' (존댓말 정책 / 능동태 / 시제), '**용어 (테이블)**' ('쓸 것 | 쓰지 말 것 | 이유'), '**서식 (bullets)**' (제목 / 목록 / 코드 / 링크 규칙), '**구조 템플릿 (bullets)**' (문서 기본 골격), '**예시 (before/after 1쌍)**', '**리뷰 체크리스트 (bullets)**'. 규칙은 예시와 함께.\n\n스타일 가이드 컨텍스트:\n${text}`,
  translate_ko_to_kosraean: (text) =>
    `Translate the Korean text below into natural Kosraean — Micronesian language of Kosrae state, Federated States of Micronesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kosraean**' and '**번역 노트**' (3 bullets in Korean — note Kosraean is an Oceanic language with a notably small consonant set).\n\n원문:\n${text}`,
  translate_ko_to_pohnpeian: (text) =>
    `Translate the Korean text below into natural Pohnpeian — Micronesian language of Pohnpei state, Federated States of Micronesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Pohnpeian**' and '**번역 노트**' (3 bullets in Korean — note Pohnpeian has an elaborate honorific (royal) speech register).\n\n원문:\n${text}`,
  translate_ko_to_yapese: (text) =>
    `Translate the Korean text below into natural Yapese — Austronesian language of Yap, Federated States of Micronesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Yapese**' and '**번역 노트**' (3 bullets in Korean — note Yap is famous for its large stone money (rai) and Yapese is its language).\n\n원문:\n${text}`,
  translate_ko_to_gilbertese: (text) =>
    `Translate the Korean text below into natural Gilbertese (Kiribati / taetae ni Kiribati) — Micronesian language of Kiribati. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kiribati**' and '**번역 노트**' (3 bullets in Korean — note Gilbertese is the national language of Kiribati, with a 13-letter alphabet).\n\n원문:\n${text}`,
  translate_ko_to_mortlockese: (text) =>
    `Translate the Korean text below into natural Mortlockese — Micronesian language of the Mortlock Islands, Chuuk state, Federated States of Micronesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Mortlockese**' and '**번역 노트**' (3 bullets in Korean — note Mortlockese is closely related to Chuukese, part of the Chuukic dialect continuum).\n\n원문:\n${text}`,
  internal_team_charter_ko: (text) =>
    `Write a Korean team charter — defines a team's mission, scope, and working norms. Use 합쇼체. Markdown: '**한 줄 (미션)**' (1줄 — 이 팀이 왜 존재), '**책임 영역 (bullets)**' (우리가 owns 하는 것), '**책임 아닌 것 (bullets)**' (경계 명확히), '**핵심 지표 (bullets)**' (팀 성공 측정), '**역할 (테이블)**' ('역할 | 책임 | 누구'), '**일하는 방식 (bullets)**' (회의 / 의사결정 / 소통 규범), '**의사결정 권한 (1줄)**' (무엇을 누가 결정), '**인터페이스 (bullets)**' (어느 팀과 어떻게 협업).\n\n팀 컨텍스트:\n${text}`,
  sales_demo_script_ko: (text) =>
    `Write a Korean product demo script — a structured, value-led demo flow for a sales call. Use 합쇼체. Markdown: '**한 줄 (데모 목표)**' (1줄 — 무엇을 보여 무엇을 느끼게), '**오프닝 (1단락)**' (고객 페인 재확인 + 어젠다), '**데모 흐름 (테이블)**' ('단계 | 보여줄 기능 | 연결할 고객 가치 | 멘트 핵심'), '**와우 모먼트 (1줄)**' (가장 임팩트 큰 순간), '**예상 질문 + 답 (테이블)**', '**피해야 할 것 (1-2 bullets)**' (기능 나열 등), '**클로징 (1단락)**' (요약 + 다음 단계 제안). 기능이 아닌 가치 중심.\n\n데모 컨텍스트:\n${text}`,
  customer_success_story_ko: (text) =>
    `Write a Korean customer success story — a short narrative of a customer's success for marketing/reference. Use 합쇼체. 스토리 + 데이터. Markdown: '**제목**' (1줄 — 결과 중심, 28자 이내), '**고객 소개 (1줄)**' (누구 / 무엇 하는 회사), '**도전 (1단락)**' (해결하려던 문제), '**해결 (1단락)**' (우리 제품을 어떻게 활용), '**결과 (bullets)**' (정량 성과 + 1줄 고객 인용), '**미래 (1줄)**' (앞으로의 계획), '**한 줄 요약 인용 (1줄)**' (헤드라인용 고객 멘트). 과장 없이 신뢰감 있게.\n\n고객 / 성과 컨텍스트:\n${text}`,
  pm_okr_draft_ko: (text) =>
    `Draft Korean product OKRs — turns a goal into a well-formed Objective with measurable Key Results. Use 합쇼체. Markdown: '**Objective (1줄)**' (영감 + 정성적 + 기한 있는), '**Key Results (테이블)**' ('KR | 측정 | 시작값 | 목표값 | 신뢰도'): 3-4개, 결과 중심(활동 아님), '**KR 품질 체크 (bullets)**' (각 KR이 측정가능/야심참/결과지향인지), '**이니셔티브 (bullets)**' (KR 달성 위한 활동 — KR과 구분), '**안티패턴 경고 (1줄)**' (활동을 KR로 착각하지 말 것). 좋은 OKR 원칙 반영.\n\n목표 컨텍스트:\n${text}`,
  internal_incident_comms_external_ko: (text) =>
    `Write Korean external incident communication — a customer-facing status message during/after an incident. Use 합쇼체 (침착 + 투명 + 책임). Markdown: '**상태 (1줄)**' (조사 중 / 완화됨 / 해결됨), '**무슨 일 (1단락)**' (고객이 겪는 것 — 기술 용어 최소), '**영향 (bullets)**' (누가 / 무엇이), '**현재 조치 (1줄)**', '**예상 복구 / 다음 업데이트 (1줄)**', '**고객 할 일 (1줄)**' (있으면), '**사과 + 약속 (1줄)**' (해결 후). 변명 없이, 추측 단정 금지.\n\n인시던트 컨텍스트:\n${text}`,
  translate_ko_to_rotuman: (text) =>
    `Translate the Korean text below into natural Rotuman (Fäeag Rotuạm) — Austronesian language of Rotuma island, Fiji. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Fäeag Rotuạm**' and '**번역 노트**' (3 bullets in Korean — note Rotuman is an Oceanic language with unusual metathesis, distinct from Fijian).\n\n원문:\n${text}`,
  translate_ko_to_wallisian: (text) =>
    `Translate the Korean text below into natural Wallisian (Faka'uvea) — Polynesian language of Wallis Island (ʻUvea). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Faka'uvea**' and '**번역 노트**' (3 bullets in Korean — note Wallisian is a Polynesian language of the French territory of Wallis and Futuna).\n\n원문:\n${text}`,
  translate_ko_to_futunan: (text) =>
    `Translate the Korean text below into natural Futunan (Fakafutuna) — Polynesian language of Futuna Island. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Fakafutuna**' and '**번역 노트**' (3 bullets in Korean — note East Futunan is closely related to Wallisian and Samoan).\n\n원문:\n${text}`,
  translate_ko_to_niuean: (text) =>
    `Translate the Korean text below into natural Niuean (ko e vagahau Niuē) — Polynesian language of Niue. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Vagahau Niuē**' and '**번역 노트**' (3 bullets in Korean — note Niuean is most closely related to Tongan, part of the Tongic subgroup).\n\n원문:\n${text}`,
  translate_ko_to_tokelauan: (text) =>
    `Translate the Korean text below into natural Tokelauan (Gagana Tokelau) — Polynesian language of Tokelau. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Gagana Tokelau**' and '**번역 노트**' (3 bullets in Korean — note Tokelauan is closely related to Tuvaluan and Samoan).\n\n원문:\n${text}`,
  internal_slo_definition_ko: (text) =>
    `Write a Korean SLO/SLI definition doc — defines service level objectives and the indicators behind them. Use 합쇼체. Markdown: '**한 줄 (서비스)**' (1줄 — 무슨 서비스의 신뢰성), '**사용자 여정 (1줄)**' (어떤 경험을 보호), '**SLI (테이블)**' ('지표 | 정의(좋은 이벤트/전체) | 측정 위치'), '**SLO 목표 (테이블)**' ('SLI | 목표 | 측정 기간'), '**에러 버짓 (1줄)**' (계산 + 의미), '**버짓 소진 정책 (bullets)**' (소진 시 무엇을 멈추나), '**알림 (bullets)**' (번 레이트 기준), '**리뷰 주기 (1줄)**'. 현실적 목표 강조 (100% 금지).\n\nSLO 컨텍스트:\n${text}`,
  sales_pricing_proposal_ko: (text) =>
    `Write a Korean pricing proposal — presents pricing to a customer clearly and persuasively. Use 합쇼체. Markdown: '**한 줄 (제안)**' (1줄 — 어떤 패키지 / 핵심 가치), '**추천 플랜 (테이블)**' ('항목 | 내용 | 가격'), '**가치 정당화 (bullets)**' (가격 ↔ 효과 연결), '**옵션 비교 (테이블)**' ('플랜 | 포함 | 가격 | 추천 대상'), '**할인 / 조건 (bullets)**' (있으면 — 명확히), '**총 투자 + ROI (1줄)**', '**계약 조건 (bullets)**' (기간 / 갱신 / 결제), '**다음 단계 (1줄)**'. 가격을 가치로 프레이밍.\n\n가격 컨텍스트:\n${text}`,
  customer_business_review_recap_ko: (text) =>
    `Write a Korean business review recap — sent to a customer after a QBR/EBR to summarize and confirm next steps. Use 합쇼체 (감사 + 명확). Markdown: '**제목**' (1줄), '**본문 인트로 (1단락)**' (시간 내줘 감사 + 핵심 1줄), '**리뷰 요약 (bullets)**' (다룬 핵심), '**합의한 것 (bullets)**' (명확히), '**액션 아이템 (테이블)**' ('액션 | 담당(우리/고객) | 시한'), '**다음 마일스톤 (1줄)**', '**마무리 (1줄)**' (파트너십 톤). 고객에게 바로 보낼 수 있는 형태.\n\n리뷰 컨텍스트:\n${text}`,
  pm_roadmap_narrative_ko: (text) =>
    `Write a Korean roadmap narrative — tells the story behind a product roadmap (the why, not just the what). Use 합쇼체. Markdown: '**한 줄 (방향)**' (1줄 — 우리가 향하는 곳), '**왜 지금 (1단락)**' (시장 / 고객 / 전략 변화), '**테마 (테이블)**' ('테마 | 왜 중요 | 대표 이니셔티브 | 기간(Now/Next/Later)'), '**Now (bullets)**' (지금 하는 것 + 이유), '**Next (bullets)**', '**Later (bullets)**' (방향성만), '**안 하는 것 (bullets)**' (의도적 제외), '**성공 모습 (1줄)**'. 날짜 약속보다 방향과 근거 중심.\n\n로드맵 컨텍스트:\n${text}`,
  internal_interview_loop_design_ko: (text) =>
    `Design a Korean interview loop — designs a structured, fair hiring loop for a role. Use 합쇼체. Markdown: '**한 줄 (역할)**' (1줄), '**평가할 역량 (bullets)**' (이 역할 성공에 필요한 것), '**인터뷰 단계 (테이블)**' ('단계 | 평가 역량 | 형식 | 시간 | 인터뷰어'), '**역량×단계 커버리지 (1줄)**' (각 역량이 최소 1회 검증되는지), '**질문 가이드 (bullets)**' (단계별 핵심 질문 유형), '**평가 기준 (bullets)**' (스코어카드 연동), '**디브리프 (1줄)**' (어떻게 결정), '**후보 경험 (1-2 bullets)**' (배려 포인트). 편향 줄이는 구조 강조.\n\n역할 / 컨텍스트:\n${text}`,
  translate_ko_to_hmong: (text) =>
    `Translate the Korean text below into natural Hmong (Hmoob, White Hmong) — Hmong-Mien language of southern China and Southeast Asia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hmoob**' and '**번역 노트**' (3 bullets in Korean — note Hmong uses the RPA romanization where final consonants mark tone).\n\n원문:\n${text}`,
  translate_ko_to_mien: (text) =>
    `Translate the Korean text below into natural Iu Mien (Yao) — Hmong-Mien language of southern China, Laos, Thailand and Vietnam. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Iu Mien**' and '**번역 노트**' (3 bullets in Korean — note Iu Mien is the main language of the Yao people, traditionally written with Chinese characters).\n\n원문:\n${text}`,
  translate_ko_to_shan: (text) =>
    `Translate the Korean text below into natural Shan (Tai) — Tai-Kadai language of Shan State, Myanmar. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Shan**' and '**번역 노트**' (3 bullets in Korean — note Shan is a Southwestern Tai language written in its own Burmese-derived script).\n\n원문:\n${text}`,
  translate_ko_to_karen: (text) =>
    `Translate the Korean text below into natural S'gaw Karen — Karenic (Sino-Tibetan) language of Myanmar and Thailand. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Karen**' and '**번역 노트**' (3 bullets in Korean — note S'gaw Karen is written in a Burmese-based script and is the largest Karen variety).\n\n원문:\n${text}`,
  translate_ko_to_mon: (text) =>
    `Translate the Korean text below into natural Mon — Austroasiatic language of southern Myanmar and Thailand. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Mon**' and '**번역 노트**' (3 bullets in Korean — note Mon is a Mon-Khmer language with a long literary tradition that influenced the Burmese script).\n\n원문:\n${text}`,
  internal_data_request_spec_ko: (text) =>
    `Write a Korean data request spec — specifies a data/analytics request clearly enough for an analyst to deliver. Use 합쇼체. Markdown: '**한 줄 (요청)**' (1줄 — 무슨 질문에 답하려는지), '**비즈니스 맥락 (1단락)**' (왜 / 어떤 결정에 쓰나), '**핵심 질문 (bullets)**' (답하고 싶은 것 — 우선순위순), '**필요 지표 / 디멘션 (테이블)**' ('지표 | 정의 | 분할 기준'), '**기간 / 필터 (bullets)**', '**산출물 형태 (1줄)**' (대시보드 / 표 / 일회성), '**우선순위 / 기한 (1줄)**', '**유의 (bullets)**' (알려진 데이터 함정). 분석가가 되묻지 않게 구체적으로.\n\n데이터 요청 컨텍스트:\n${text}`,
  sales_negotiation_prep_ko: (text) =>
    `Write a Korean negotiation prep doc — prepares a rep for a deal negotiation. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 이상적 결과), '**우리 입장 (bullets)**' (목표 / 최소 수용선(walk-away) / 양보 가능), '**고객 입장 추정 (bullets)**' (그들의 니즈 / 제약 / 대안(BATNA)), '**협상 변수 (테이블)**' ('변수 | 우리에게 가치 | 그들에게 가치 | 양보 우선순위'), '**예상 요구 + 대응 (테이블)**', '**가치 재강조 포인트 (bullets)**', '**레드라인 (bullets)**' (절대 양보 불가), '**오프닝 / 클로징 멘트 (각 1줄)**'. 가격 양보보다 가치 교환 중심.\n\n협상 컨텍스트:\n${text}`,
  customer_kickoff_agenda_ko: (text) =>
    `Write a Korean customer kickoff meeting agenda — structures the first onboarding meeting with a new customer. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 이 킥오프로 무엇을 정렬), '**참석자 (bullets)**' (양측 누구 / 역할), '**아젠다 (테이블)**' ('시간 | 주제 | 진행 | 목표'): 소개 / 목표 합의 / 성공 기준 / 일정 / 역할 / 다음 단계, '**합의할 것 (bullets)**' (성공 정의 / 마일스톤), '**보여줄 것 (1줄)**', '**액션 아이템 양식 (1줄)**', '**다음 미팅 (1줄)**'. 첫인상 + 명확한 정렬 강조.\n\n킥오프 컨텍스트:\n${text}`,
  pm_jobs_to_be_done_ko: (text) =>
    `Write a Korean Jobs-to-be-Done (JTBD) analysis — frames what customers are really trying to accomplish. Use 합쇼체. Markdown: '**한 줄 (핵심 잡)**' (1줄 — '~할 때, ~하고 싶다, 그래서 ~'), '**잡 스토리 (bullets)**' (상황 + 동기 + 기대 결과 형태로), '**기능적 / 감정적 / 사회적 잡 (테이블)**' ('차원 | 고객이 원하는 것'), '**현재 해결책 + 불만 (bullets)**' (지금 어떻게 / 왜 부족), '**성공 기준 (bullets)**' (고객 관점의 '잘 됐다'), '**기회 (bullets)**' (덜 충족된 잡), '**시사점 (1줄)**'. 솔루션이 아닌 잡에 집중.\n\n고객 / 컨텍스트:\n${text}`,
  internal_retro_action_review_ko: (text) =>
    `Write a Korean retro action review — checks whether past retrospective action items actually got done and why. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 실행률 + 패턴), '**지난 액션 점검 (테이블)**' ('액션 | 담당 | 상태(완료/진행/미착수) | 결과/막힌 이유'), '**완료된 것의 효과 (bullets)**' (실제 개선됐나), '**반복되는 미완 패턴 (bullets)**' (왜 자꾸 안 되나), '**시스템 원인 (1단락)**' (개인 탓 아님 — 프로세스), '**개선 제안 (bullets)**' (액션이 실행되게 만드는 방법), '**이번 사이클 캐리오버 (bullets)**'. 책임 추궁 아닌 학습.\n\n액션 리뷰 컨텍스트:\n${text}`,
  translate_ko_to_chin: (text) =>
    `Translate the Korean text below into natural Hakha Chin (Lai) — Kuki-Chin (Sino-Tibetan) language of Chin State, Myanmar, and Mizoram. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hakha Chin**' and '**번역 노트**' (3 bullets in Korean — note Hakha Chin is a major lingua franca among Chin communities, written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_rakhine: (text) =>
    `Translate the Korean text below into natural Rakhine (Arakanese) — a Burmish language of Rakhine State, western Myanmar. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Rakhine**' and '**번역 노트**' (3 bullets in Korean — note Rakhine is closely related to Burmese but preserves an older 'r' sound, written in Burmese script).\n\n원문:\n${text}`,
  translate_ko_to_jingpho: (text) =>
    `Translate the Korean text below into natural Jingpho (Kachin) — Sino-Tibetan language of Kachin State, Myanmar, and Yunnan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Jinghpaw**' and '**번역 노트**' (3 bullets in Korean — note Jingpho is the main Kachin language, written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_palaung: (text) =>
    `Translate the Korean text below into natural Palaung (Ta'ang) — Austroasiatic (Mon-Khmer) language of northern Shan State, Myanmar. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Palaung**' and '**번역 노트**' (3 bullets in Korean — note Palaung is a Mon-Khmer language of tea-growing highland communities).\n\n원문:\n${text}`,
  translate_ko_to_wa: (text) =>
    `Translate the Korean text below into natural Wa (Vāx) — Austroasiatic (Mon-Khmer) language of the Myanmar-China border highlands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Wa**' and '**번역 노트**' (3 bullets in Korean — note Wa is a Palaungic Mon-Khmer language, written in a Latin-based orthography).\n\n원문:\n${text}`,
  internal_architecture_overview_ko: (text) =>
    `Write a Korean system architecture overview — gives a newcomer or reviewer a clear mental model of a system. Use 합쇼체. Markdown: '**한 줄 (시스템)**' (1줄 — 무엇을 하는 시스템), '**핵심 책임 (bullets)**', '**주요 컴포넌트 (테이블)**' ('컴포넌트 | 역할 | 기술 | 소유'), '**데이터 흐름 (numbered)**' (요청이 들어와 나가기까지), '**외부 의존성 (bullets)**', '**데이터 저장 (bullets)**' (무엇을 어디에), '**확장 / 장애 포인트 (bullets)**', '**알려진 한계 / 기술 부채 (bullets)**', '**더 알아볼 곳 (1줄)**'. 다이어그램 없이도 그림이 그려지게.\n\n시스템 컨텍스트:\n${text}`,
  sales_proof_of_concept_plan_ko: (text) =>
    `Write a Korean Proof of Concept (POC) plan — defines a time-boxed POC to prove value before a deal. Use 합쇼체. Markdown: '**한 줄 (POC 목표)**' (1줄 — 무엇을 증명), '**성공 기준 (테이블)**' ('기준 | 측정 | 합격선') — 사전 합의 강조, '**범위 (bullets)**' (포함 / 제외), '**기간 / 마일스톤 (테이블)**' ('단계 | 활동 | 시한 | 담당'), '**필요 자원 (bullets)**' (양측), '**리스크 / 가정 (bullets)**', '**평가 / 의사결정 (1줄)**' (끝나고 누가 어떻게 판단), '**POC 후 전환 (1줄)**'. 명확한 합격 기준이 핵심.\n\nPOC 컨텍스트:\n${text}`,
  customer_renewal_proposal_ko: (text) =>
    `Write a Korean renewal proposal — presents a renewal offer that reinforces value. Use 합쇼체. Markdown: '**한 줄 (제안)**' (1줄 — 갱신 조건 핵심), '**지난 기간 가치 (bullets)**' (데이터 + 성과 — 왜 계속할 가치가 있나), '**갱신 옵션 (테이블)**' ('옵션 | 기간 | 가격 | 포함'), '**변경 사항 (bullets)**' (가격/패키지 변화 — 투명하게), '**확장 제안 (1줄)**' (있으면), '**총 가치 / ROI (1줄)**', '**일정 (1줄)**' (갱신일 / 결정 필요 시점), '**다음 단계 (1줄)**'. 가치 재확인 → 자연스러운 갱신.\n\n갱신 컨텍스트:\n${text}`,
  pm_release_readiness_checklist_ko: (text) =>
    `Write a Korean release readiness checklist — a go/no-go checklist before shipping. Use 합쇼체. Markdown: '**한 줄 (릴리스)**' (1줄 — 무엇을 / 언제), '**기능 완성도 (체크박스 bullets)**' (스펙 충족 / 엣지케이스), '**품질 (체크박스 bullets)**' (테스트 / QA / 회귀), '**운영 준비 (체크박스 bullets)**' (모니터링 / 알림 / 롤백 / 런북), '**문서 / 지원 (체크박스 bullets)**' (릴리스 노트 / 지원팀 / FAQ), '**비즈니스 (체크박스 bullets)**' (마케팅 / 세일즈 / 법무), '**Go/No-go (테이블)**' ('항목 | 상태 | 차단 여부'), '**최종 판정 (1줄)**'. 각 항목 담당 표기.\n\n릴리스 컨텍스트:\n${text}`,
  internal_team_health_survey_ko: (text) =>
    `Design a Korean team health survey — a short pulse survey to gauge team health and morale. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**설문 문항 (테이블)**' ('영역 | 문항 | 척도'): 업무 명확성 / 자율성 / 협업 / 워크로드 / 성장 / 인정 / 심리적 안전 — 각 1-2문항, '**자유 응답 (bullets)**' (2-3개 개방형), '**운영 (bullets)**' (익명 / 주기 / 소요시간), '**분석 / 후속 (1줄)**' (결과를 어떻게 행동으로), '**주의 (1줄)**' (서베이 피로 / 응답 신뢰). 짧고 행동으로 이어지게.\n\n팀 / 컨텍스트:\n${text}`,
  translate_ko_to_bhojpuri: (text) =>
    `Translate the Korean text below into natural Bhojpuri — Indo-Aryan language of western Bihar and eastern Uttar Pradesh, India, and the Terai of Nepal. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**भोजपुरी**' and '**번역 노트**' (3 bullets in Korean — note Bhojpuri is written in Devanagari and has a large diaspora across Mauritius, Fiji and the Caribbean).\n\n원문:\n${text}`,
  translate_ko_to_maithili: (text) =>
    `Translate the Korean text below into natural Maithili — Indo-Aryan language of the Mithila region, Bihar (India) and Nepal. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**मैथिली**' and '**번역 노트**' (3 bullets in Korean — note Maithili is a scheduled language of India with its own historic Tirhuta script, now usually written in Devanagari).\n\n원문:\n${text}`,
  translate_ko_to_konkani: (text) =>
    `Translate the Korean text below into natural Konkani — Indo-Aryan language of the Konkan coast (Goa) and parts of Karnataka and Kerala. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**कोंकणी**' and '**번역 노트**' (3 bullets in Korean — note Konkani is the official language of Goa, written in Devanagari, Kannada, and Roman scripts).\n\n원문:\n${text}`,
  translate_ko_to_tulu: (text) =>
    `Translate the Korean text below into natural Tulu — Dravidian language of the Tulu Nadu region of coastal Karnataka and Kerala, India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ತುಳು**' and '**번역 노트**' (3 bullets in Korean — note Tulu is a Dravidian language usually written in the Kannada script, with a rich oral epic (paddana) tradition).\n\n원문:\n${text}`,
  translate_ko_to_santali: (text) =>
    `Translate the Korean text below into natural Santali — Munda (Austroasiatic) language of eastern India and parts of Bangladesh and Nepal. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ᱥᱟᱱᱛᱟᱲᱤ**' and '**번역 노트**' (3 bullets in Korean — note Santali is a scheduled language of India written in its own Ol Chiki script).\n\n원문:\n${text}`,
  internal_tech_debt_proposal_ko: (text) =>
    `Write a Korean tech debt proposal — makes the case to invest in paying down specific technical debt. Use 합쇼체. 비개발 이해관계자도 이해하게. Markdown: '**한 줄 (제안)**' (1줄 — 무슨 부채를 / 왜 지금), '**부채 설명 (1단락)**' (비유로 — 비개발자도 이해), '**현재 비용 (bullets)**' (속도 저하 / 버그 / 리스크 — 가능하면 수치), '**방치 시 (bullets)**' (시간이 갈수록), '**제안 (1단락)**' (무엇을 어떻게), '**필요 투자 (1줄)**' (시간 / 사람), '**기대 효과 (bullets)**', '**리스크 / 안 할 이유 (bullets)**' (균형), '**요청 (1줄)**'.\n\n기술 부채 컨텍스트:\n${text}`,
  sales_executive_briefing_ko: (text) =>
    `Write a Korean executive briefing — a tight pre-read for a senior exec before a key customer meeting. Use 합쇼체. 1페이지, 스캔 가능. Markdown: '**한 줄 (미팅)**' (1줄 — 누구와 / 왜 / 목표), '**참석자 (bullets)**' ('이름 — 역할 — 알아둘 점'), '**계정 스냅샷 (bullets)**' (ARR / 관계 / 히스토리 핵심), '**이번 미팅 목표 (bullets)**', '**민감 이슈 (bullets)**' (지뢰 + 대응), '**임원이 해줄 일 (bullets)**' (정확히 무엇을 — 후원 / 결정 / 관계), '**핵심 메시지 (1줄)**', '**피할 주제 (1줄)**'. 임원 시간 존중 — 군더더기 제로.\n\n미팅 컨텍스트:\n${text}`,
  customer_usage_review_ko: (text) =>
    `Write a Korean product usage review — analyzes how a customer is actually using the product. Use 합쇼체. Markdown: '**한 줄 (사용 현황)**' (1줄 — 건강/우려), '**활성 (테이블)**' ('지표 | 값 | 추세'): 활성 사용자 / 빈도 / 핵심 액션, '**기능 채택 (테이블)**' ('기능 | 채택 여부 | 사용 깊이'), '**잘 쓰는 영역 (bullets)**', '**저활용 / 미사용 (bullets)**' (각 '왜 — 기회'), '**이상 신호 (bullets)**' (이탈 전조), '**액션 제안 (테이블)**' ('액션 | 목적 | 담당'), '**한 줄 결론 (1줄)**'. 데이터 → 액션 연결.\n\n사용 데이터 컨텍스트:\n${text}`,
  pm_metrics_dashboard_spec_ko: (text) =>
    `Write a Korean metrics dashboard spec — defines what a product/business dashboard should show and why. Use 합쇼체. Markdown: '**한 줄 (대시보드)**' (1줄 — 누구를 위해 / 무슨 결정), '**핵심 질문 (bullets)**' (이 대시보드가 답해야 할 것), '**지표 (테이블)**' ('지표 | 정의 | 분할 | 목표/벤치마크 | 시각화'), '**레이아웃 (numbered)**' (위→아래 우선순위), '**필터 / 인터랙션 (bullets)**', '**갱신 주기 / 출처 (1줄)**', '**오해 방지 (bullets)**' (잘못 읽힐 여지 + 주석), '**안 넣을 것 (1줄)**' (노이즈 방지). 결정 중심 설계.\n\n대시보드 컨텍스트:\n${text}`,
  internal_promotion_case_ko: (text) =>
    `Write a Korean promotion case (packet) — argues that someone is already operating at the next level. Use 합쇼체. 근거 + 임팩트 중심. Markdown: '**한 줄 (추천)**' (1줄 — 누구 / 어느 레벨로), '**현재 vs 다음 레벨 (1줄)**', '**핵심 근거 (테이블)**' ('역량 | 다음 레벨 기대 | 실제 사례 + 임팩트'), '**대표 성과 (bullets)**' (각 '무엇 — 범위 — 결과(수치)'), '**범위 / 영향력 (1단락)**' (팀/조직 차원), '**리더십 / 협업 증거 (bullets)**', '**주변 평가 (bullets)**' (동료/이해관계자 인용), '**한 줄 결론 (1줄)**'. '이미 그 레벨로 일하고 있다'를 증명.\n\n승진 컨텍스트:\n${text}`,
  translate_ko_to_dogri: (text) =>
    `Translate the Korean text below into natural Dogri — Indo-Aryan language of the Jammu region and Himachal Pradesh, India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**डोगरी**' and '**번역 노트**' (3 bullets in Korean — note Dogri is a scheduled language of India, a tonal Indo-Aryan language written in Devanagari).\n\n원문:\n${text}`,
  translate_ko_to_bodo: (text) =>
    `Translate the Korean text below into natural Bodo — Sino-Tibetan (Tibeto-Burman) language of Assam, India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**बर'**' and '**번역 노트**' (3 bullets in Korean — note Bodo is a scheduled language of India, the largest Tibeto-Burman language of Assam, written in Devanagari).\n\n원문:\n${text}`,
  translate_ko_to_manipuri: (text) =>
    `Translate the Korean text below into natural Meitei (Manipuri) — Sino-Tibetan language of Manipur, India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ꯃꯩꯇꯩꯂꯣꯟ**' and '**번역 노트**' (3 bullets in Korean — note Meitei is a scheduled language of India with its own Meitei Mayek script).\n\n원문:\n${text}`,
  translate_ko_to_khasi: (text) =>
    `Translate the Korean text below into natural Khasi — Austroasiatic language of Meghalaya, India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Khasi**' and '**번역 노트**' (3 bullets in Korean — note Khasi is a Mon-Khmer language unusual for its location in northeast India, written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_mizo: (text) =>
    `Translate the Korean text below into natural Mizo (Lushai) — Kuki-Chin (Sino-Tibetan) language of Mizoram, India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Mizo ṭawng**' and '**번역 노트**' (3 bullets in Korean — note Mizo is written in Latin script and is the main language of Mizoram).\n\n원문:\n${text}`,
  internal_dev_env_setup_guide_ko: (text) =>
    `Write a Korean developer environment setup guide — gets a new engineer's local environment running. Use 합쇼체. 따라하면 되는 형태. Markdown: '**한 줄 (목표)**' (1줄 — 끝나면 무엇이 돌아가나), '**사전 요구사항 (bullets)**' (OS / 버전 / 계정 / 권한), '**설치 단계 (numbered)**' (각 단계: 명령 + 기대 출력 + 확인), '**환경 변수 / 설정 (bullets)**', '**실행 / 검증 (bullets)**' ('이게 보이면 성공'), '**자주 겪는 문제 (테이블)**' ('증상 | 원인 | 해결'), '**다음 (1줄)**' (첫 기여까지). 막힘 없이 따라가게.\n\n환경 컨텍스트:\n${text}`,
  sales_close_plan_ko: (text) =>
    `Write a Korean deal close plan — maps the final steps to get a deal signed by a target date. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 언제까지 / 얼마), '**현재 단계 (1줄)**' (어디까지 왔나), '**남은 단계 (테이블)**' ('단계 | 활동 | 우리/고객 담당 | 시한 | 상태'), '**의사결정 프로세스 (bullets)**' (누가 사인 / 어떤 승인), '**남은 장애물 (bullets)**' (각 '장애물 — 해소 방법'), '**필요 자원 (bullets)**' (법무 / 보안 / 임원), '**리스크 (1줄)**', '**다음 48시간 액션 (bullets)**'. 마감 역산 + 구체성.\n\n딜 컨텍스트:\n${text}`,
  customer_executive_alignment_ko: (text) =>
    `Write a Korean executive alignment doc — aligns customer and vendor execs on a shared strategic direction. Use 합쇼체. Markdown: '**한 줄 (정렬 목표)**' (1줄), '**고객 전략 우선순위 (bullets)**' (그들의 비즈니스 목표), '**우리 기여 (테이블)**' ('고객 우선순위 | 우리가 돕는 방식 | 증거'), '**공동 목표 (bullets)**' (양측이 함께 추구), '**거버넌스 (1줄)**' (임원 간 점검 리듬), '**필요한 임원 후원 (bullets)**', '**리스크 / 의존성 (bullets)**', '**12개월 비전 (1줄)**'. C레벨 언어, 전술 아닌 전략.\n\n정렬 컨텍스트:\n${text}`,
  pm_feature_deprecation_plan_ko: (text) =>
    `Write a Korean feature deprecation plan — retires a feature with minimal user pain. Use 합쇼체. Markdown: '**한 줄 (폐기)**' (1줄 — 무슨 기능 / 왜), '**근거 (bullets)**' (사용량 / 비용 / 전략 — 데이터), '**영향받는 사용자 (테이블)**' ('세그먼트 | 사용 정도 | 대안'), '**마이그레이션 경로 (numbered)**' (사용자가 옮겨갈 길), '**커뮤니케이션 plan (테이블)**' ('대상 | 메시지 | 시점'), '**타임라인 (테이블)**' ('단계 | 날짜'): 공지 / 신규차단 / 읽기전용 / 완전제거, '**예외 처리 (1줄)**', '**롤백 트리거 (1줄)**'. 사용자 신뢰 보호 우선.\n\n폐기 컨텍스트:\n${text}`,
  internal_proposal_one_pager_ko: (text) =>
    `Write a Korean one-page proposal — a single-page pitch to get buy-in for an idea. Use 합쇼체. 1페이지 엄수. Markdown: '**제목 (1줄)**', '**한 줄 요약 (1줄)**' (무엇을 / 왜 / 요청), '**문제 (2-3줄)**', '**제안 (2-3줄)**' (핵심 아이디어), '**기대 효과 (bullets)**' (3개 — 가능하면 수치), '**필요 자원 (1줄)**', '**리스크 (1-2 bullets)**', '**요청 (1줄)**' (의사결정자에게 정확히 무엇을). 길면 실패 — 날카롭게.\n\n제안 컨텍스트:\n${text}`,
  translate_ko_to_zhuang: (text) =>
    `Translate the Korean text below into natural Zhuang (Vahcuengh) — Tai-Kadai language of Guangxi, southern China. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Vahcuengh**' and '**번역 노트**' (3 bullets in Korean — note Standard Zhuang is written in a Latin-based orthography and is the largest minority language of China).\n\n원문:\n${text}`,
  translate_ko_to_uyghur: (text) =>
    `Translate the Korean text below into natural Uyghur (ئۇيغۇرچە) — Turkic language of Xinjiang, China. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ئۇيغۇرچە**' and '**번역 노트**' (3 bullets in Korean — note Uyghur is a Karluk Turkic language written in an Arabic-derived script, right-to-left).\n\n원문:\n${text}`,
  translate_ko_to_tibetan: (text) =>
    `Translate the Korean text below into natural Standard Tibetan (བོད་སྐད) — Sino-Tibetan language of Tibet. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**བོད་སྐད**' and '**번역 노트**' (3 bullets in Korean — note Tibetan has an honorific register and is written in the Tibetan abugida script).\n\n원문:\n${text}`,
  translate_ko_to_dungan: (text) =>
    `Translate the Korean text below into natural Dungan — a Sinitic language of Central Asia (Kyrgyzstan, Kazakhstan) descended from northwestern Mandarin. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Хуэйзў йүян**' and '**번역 노트**' (3 bullets in Korean — note Dungan is the only Sinitic language conventionally written in Cyrillic).\n\n원문:\n${text}`,
  translate_ko_to_salar: (text) =>
    `Translate the Korean text below into natural Salar — Oghuz Turkic language of Qinghai and Gansu, China. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Sal​ır**' and '**번역 노트**' (3 bullets in Korean — note Salar is an Oghuz Turkic language surrounded by Sinitic and Tibetan, with heavy borrowing).\n\n원문:\n${text}`,
  internal_security_review_ko: (text) =>
    `Write a Korean security review — reviews a feature/system for security risks before launch. Use 합쇼체. Markdown: '**한 줄 (결론)**' (1줄 — 출시 가능 / 조건부 / 불가), '**범위 (1줄)**' (무엇을 리뷰), '**데이터 / 신뢰 경계 (bullets)**' (어떤 데이터 / 어디서 어디로), '**위협 (테이블)**' ('위협 | 가능성 | 영향 | 등급'): 인증/인가 / 입력검증 / 데이터노출 / 의존성 / 비밀관리, '**발견 사항 (테이블)**' ('이슈 | 심각도 | 권고'), '**필수 수정 (bullets)**' (출시 전), '**권장 수정 (bullets)**', '**잔여 리스크 (1줄)**'. 사실 + 실행 가능한 권고.\n\n보안 리뷰 컨텍스트:\n${text}`,
  sales_reference_request_ko: (text) =>
    `Draft a Korean customer reference request — asks a happy customer to be a reference, respectfully. Use 합쇼체 (정중 + 부담 없이). Markdown: '**제목**' (1줄), '**본문**' (3-4 단락: 1) 따뜻한 인사 + 함께한 성과 1줄 인정, 2) 부탁 — 무엇을 (레퍼런스 콜 / 케이스 스터디 / 리뷰) + 왜 그들이 적임, 3) 부담 줄이기 — 소요 시간 / 유연성 / 거절해도 괜찮음, 4) 감사 + 다음 단계), '**옵션 제시 (bullets)**' (참여 방식 몇 가지), '**보상/감사 (1줄)**' (있으면). 관계 우선, 압박 금지.\n\n레퍼런스 컨텍스트:\n${text}`,
  customer_health_check_call_notes_ko: (text) =>
    `Structure Korean health check call notes — captures a regular customer health check-in. Use 합쇼체. Markdown: '**한 줄 (헬스)**' (1줄 — 🟢/🟡/🔴 + 핵심), '**참석자 (1줄)**', '**잘 되는 것 (bullets)**' (고객 언어로), '**우려 / 페인 (테이블)**' ('이슈 | 영향 | 긴급도'), '**사용 / 채택 신호 (bullets)**', '**고객 목표 업데이트 (1줄)**' (바뀐 것), '**기회 (bullets)**' (확장 / 가치 확대), '**액션 (테이블)**' ('액션 | 담당 | 시한'), '**다음 체크인 (1줄)**'. 관계 + 가치 신호 포착.\n\n콜 노트:\n${text}`,
  pm_competitive_positioning_ko: (text) =>
    `Write a Korean competitive positioning statement — defines how a product is positioned against alternatives. Use 합쇼체. Markdown: '**한 줄 (포지셔닝)**' (1줄 — '~를 위한 ~로서, 우리는 ~이다, ~와 달리 ~'), '**타깃 (1줄)**' (누구를 위해), '**카테고리 (1줄)**' (어떤 시장으로 인식되길), '**핵심 차별점 (bullets)**' (각 '차별점 — 근거 — 왜 중요'), '**경쟁 프레임 (테이블)**' ('대안 | 그들의 포지션 | 우리 대비'), '**증거 (bullets)**' (포지셔닝 뒷받침), '**메시지 기둥 (bullets)**', '**피할 메시지 (1줄)**'. 차별화 + 신뢰성.\n\n포지셔닝 컨텍스트:\n${text}`,
  internal_quarterly_retro_ko: (text) =>
    `Facilitate a Korean quarterly retrospective — a higher-altitude retro reflecting on a whole quarter. Use 합쇼체. Markdown: '**한 줄 (분기 총평)**' (1줄), '**목표 대비 성과 (테이블)**' ('목표 | 결과 | 달성도 | 코멘트'), '**잘된 것 (bullets)**' (반복하고 싶은 패턴), '**아쉬운 것 (bullets)**' (시스템 관점), '**놀란 것 / 배운 것 (bullets)**', '**팀 / 협업 신호 (1단락)**' (사기 / 번아웃 / 성장), '**다음 분기 바꿀 것 (테이블)**' ('변화 | 이유 | 담당'), '**한 줄 다짐 (1줄)**'. 개인 비난 없이 패턴과 학습.\n\n분기 retro 컨텍스트:\n${text}`,
  translate_ko_to_tuvan: (text) =>
    `Translate the Korean text below into natural Tuvan (Tyva dyl) — Siberian Turkic language of the Tuva Republic, Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Тыва дыл**' and '**번역 노트**' (3 bullets in Korean — note Tuvan is written in Cyrillic and is famous for its throat singing (khoomei) tradition).\n\n원문:\n${text}`,
  translate_ko_to_khakas: (text) =>
    `Translate the Korean text below into natural Khakas — Siberian Turkic language of the Khakassia Republic, Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Хакас тілі**' and '**번역 노트**' (3 bullets in Korean — note Khakas is a South Siberian Turkic language written in Cyrillic).\n\n원문:\n${text}`,
  translate_ko_to_altai: (text) =>
    `Translate the Korean text below into natural Altai (Altai til) — Turkic language of the Altai Republic, Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Алтай тил**' and '**번역 노트**' (3 bullets in Korean — note Altai is a South Siberian Turkic language of the Altai mountains, written in Cyrillic).\n\n원문:\n${text}`,
  translate_ko_to_shor: (text) =>
    `Translate the Korean text below into natural Shor — endangered Turkic language of the Kemerovo region, southern Siberia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Шор тили**' and '**번역 노트**' (3 bullets in Korean — note Shor is a critically endangered South Siberian Turkic language written in Cyrillic).\n\n원문:\n${text}`,
  translate_ko_to_dolgan: (text) =>
    `Translate the Korean text below into natural Dolgan — Turkic language of the Taymyr Peninsula, far northern Siberia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Долган тыла**' and '**번역 노트**' (3 bullets in Korean — note Dolgan is closely related to Yakut/Sakha, spoken by reindeer-herding communities).\n\n원문:\n${text}`,
  internal_backlog_grooming_notes_ko: (text) =>
    `Structure Korean backlog grooming (refinement) notes — captures decisions from a backlog refinement session. Use 합쇼체. Markdown: '**한 줄 (세션)**' (1줄 — 무엇을 다뤘나), '**리파인된 항목 (테이블)**' ('항목 | 상태(ready/needs-info/split) | 추정 | 우선순위 | 코멘트'), '**분할한 항목 (bullets)**' (큰 것 → 작은 것), '**막힌 항목 (bullets)**' (각 '항목 — 필요한 정보 — 누가'), '**제외 / 백버너 (bullets)**', '**다음 스프린트 후보 (bullets)**', '**액션 (테이블)**' ('액션 | 담당 | 시한'). 결정과 근거 중심.\n\n그루밍 컨텍스트:\n${text}`,
  sales_territory_plan_ko: (text) =>
    `Write a Korean sales territory plan — a rep's plan to work a territory/book of business. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 영역 + 매출 목표), '**영역 개요 (bullets)**' (계정 수 / 세그먼트 / 잠재력), '**계정 세분화 (테이블)**' ('티어 | 계정 | 전략 | 우선순위'): A/B/C, '**파이프라인 갭 (1줄)**' (목표 vs 현재), '**핵심 액션 (bullets)**' (신규 / 확장 / 갱신별), '**시간 배분 (1줄)**' (티어별), '**필요 지원 (bullets)**', '**90일 마일스톤 (테이블)**' ('마일스톤 | 시한'). 우선순위 + 집중.\n\n영역 컨텍스트:\n${text}`,
  customer_onboarding_status_ko: (text) =>
    `Write a Korean onboarding status update — tracks where a new customer is in onboarding. Use 합쇼체. Markdown: '**한 줄 (상태)**' (1줄 — 🟢/🟡/🔴 + 일정 대비), '**온보딩 목표 (1줄)**', '**단계 진행 (테이블)**' ('단계 | 상태 | 담당 | 메모'): 킥오프 / 설정 / 데이터 / 교육 / 첫 가치 / 안착, '**완료한 것 (bullets)**', '**막힌 것 (bullets)**' (각 '블로커 — 필요 — 누가'), '**리스크 (1줄)**' (지연 / 이탈 신호), '**다음 마일스톤 (1줄)**' (Time-to-value 목표), '**액션 (테이블)**'. 첫 가치 도달 가속 중심.\n\n온보딩 컨텍스트:\n${text}`,
  pm_ab_test_results_ko: (text) =>
    `Write a Korean A/B test results readout — reports an experiment's outcome and recommendation. Use 합쇼체. Markdown: '**한 줄 (결론)**' (1줄 — 출시 / 중단 / 재실험 + 핵심), '**가설 (1줄)**', '**셋업 (bullets)**' (변형 / 대상 / 기간 / 표본), '**결과 (테이블)**' ('지표 | 대조군 | 실험군 | 변화 | 유의성(p/신뢰구간)'), '**가드레일 지표 (bullets)**' (악화 없었나), '**해석 (1단락)**' (왜 이런 결과 — 과대해석 경계), '**권고 (1줄)**', '**후속 (bullets)**' (추가 검증 / 세그먼트). 통계적 겸손 유지.\n\n실험 결과 컨텍스트:\n${text}`,
  internal_eng_weekly_digest_ko: (text) =>
    `Write a Korean engineering weekly digest — a scannable weekly update for an eng org. Use 합쇼체. Markdown: '**한 줄 (이번 주)**' (1줄 — 가장 중요한 것), '**출시 / 머지 (bullets)**' (사용자/팀 영향 위주), '**진행 중 (bullets)**' (주요 작업 상태), '**인시던트 / 신뢰성 (bullets)**' (있으면 — 간결), '**기술 결정 (bullets)**' (ADR / 방향), '**막힌 것 / 도움 필요 (bullets)**', '**지표 (1줄)**' (배포 빈도 / 안정성 등), '**다음 주 (bullets)**', '**축하 / 감사 (1줄)**'. 군더더기 없이.\n\n엔지니어링 주간 컨텍스트:\n${text}`,
  translate_ko_to_andi: (text) =>
    `Translate the Korean text below into natural Andi — Northeast Caucasian (Avar-Andic) language of Dagestan, Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Andi**' and '**번역 노트**' (3 bullets in Korean — note Andi is an Avar-Andic language with a large consonant inventory; it is largely unwritten and Avar serves as the literary language).\n\n원문:\n${text}`,
  translate_ko_to_tsez: (text) =>
    `Translate the Korean text below into natural Tsez (Dido) — Northeast Caucasian language of southern Dagestan, Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tsez**' and '**번역 노트**' (3 bullets in Korean — note Tsez has an exceptionally rich case system and is mostly an oral language).\n\n원문:\n${text}`,
  translate_ko_to_rutul: (text) =>
    `Translate the Korean text below into natural Rutul — Lezgic (Northeast Caucasian) language of southern Dagestan, Russia, and Azerbaijan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Rutul**' and '**번역 노트**' (3 bullets in Korean — note Rutul is a Lezgic language written in Cyrillic since the 1990s).\n\n원문:\n${text}`,
  translate_ko_to_tsakhur: (text) =>
    `Translate the Korean text below into natural Tsakhur — Lezgic (Northeast Caucasian) language of Dagestan and Azerbaijan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tsakhur**' and '**번역 노트**' (3 bullets in Korean — note Tsakhur is a Lezgic language spoken on both sides of the Russia-Azerbaijan border).\n\n원문:\n${text}`,
  translate_ko_to_aghul: (text) =>
    `Translate the Korean text below into natural Aghul — Lezgic (Northeast Caucasian) language of southern Dagestan, Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Aghul**' and '**번역 노트**' (3 bullets in Korean — note Aghul is a Lezgic language closely related to Lezgian and Tabasaran).\n\n원문:\n${text}`,
  internal_meeting_facilitation_guide_ko: (text) =>
    `Write a Korean meeting facilitation guide — helps someone run an effective, inclusive meeting. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄 — 이 미팅이 필요한 이유 / 결정할 것), '**사전 준비 (bullets)**' (아젠다 / 사전 읽기 / 역할), '**진행 흐름 (테이블)**' ('시간 | 단계 | 진행 방식'), '**참여 유도 (bullets)**' (조용한 사람 끌어들이기 / 라운드로빈), '**의사결정 방법 (1줄)**' (합의 / RAPID / 투표), '**탈선 대응 (bullets)**' (파킹랏 등), '**마무리 (bullets)**' (결정 / 액션 / 다음), '**안티패턴 (1줄)**' (회의를 위한 회의). 포용 + 결과 중심.\n\n미팅 컨텍스트:\n${text}`,
  sales_deal_review_ko: (text) =>
    `Write a Korean deal review — an internal review of a deal's health for forecasting and coaching. Use 합쇼체. Markdown: '**한 줄 (딜)**' (1줄 — 단계 + 확률 + 핵심 리스크), '**딜 요약 (bullets)**' (고객 / 규모 / 예상 클로즈), '**MEDDIC 체크 (테이블)**' ('요소 | 상태 | 메모'): Metrics / Economic buyer / Decision criteria / Decision process / Identify pain / Champion, '**강점 (bullets)**', '**리스크 / 갭 (bullets)**', '**다음 액션 (테이블)**' ('액션 | 담당 | 시한'), '**필요한 코칭/지원 (1줄)**', '**예측 신뢰도 (1줄)**'. 솔직한 내부 평가.\n\n딜 컨텍스트:\n${text}`,
  customer_feedback_loop_ko: (text) =>
    `Design a Korean customer feedback loop — sets up a repeatable process to capture, route, and close the loop on feedback. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄), '**수집 채널 (테이블)**' ('채널 | 무엇을 수집 | 빈도'), '**분류 / 라우팅 (bullets)**' (어떻게 태깅 / 누구에게), '**우선순위 기준 (bullets)**', '**제품 연계 (1줄)**' (어떻게 로드맵에 반영), '**루프 닫기 (bullets)**' (고객에게 무엇이 됐는지 알리기), '**측정 (bullets)**' (피드백 → 조치 비율 등), '**역할 (테이블)**' ('단계 | 담당'). 닫는 루프 강조.\n\n피드백 컨텍스트:\n${text}`,
  pm_discovery_summary_ko: (text) =>
    `Write a Korean product discovery summary — synthesizes user research/discovery into decisions. Use 합쇼체. Markdown: '**한 줄 (핵심 발견)**' (1줄), '**디스커버리 질문 (1줄)**' (무엇을 알아내려 했나), '**방법 / 표본 (bullets)**' (인터뷰 / 설문 — 누구 몇 명), '**핵심 인사이트 (테이블)**' ('인사이트 | 근거 | 확신도'), '**검증된 가정 / 깨진 가정 (bullets)**', '**기회 (bullets)**' (해결할 가치 있는 문제), '**권고 (1단락)**' (다음에 무엇을), '**남은 불확실성 (bullets)**'. 근거와 의견 구분.\n\n디스커버리 컨텍스트:\n${text}`,
  internal_engineering_standards_ko: (text) =>
    `Write a Korean engineering standards doc — codifies how a team writes and ships code. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**원칙 (bullets)**' (단순함 / 가독성 / 테스트 등), '**코드 (bullets)**' (스타일 / 리뷰 / 네이밍 규칙 — 도구로 강제할 것 표시), '**테스트 (bullets)**' (무엇을 / 커버리지 기대), '**리뷰 (bullets)**' (PR 크기 / SLA / 승인 규칙), '**배포 (bullets)**' (CI / 롤백 / 플래그), '**관측성 (bullets)**' (로그 / 메트릭 / 알림), '**예외 처리 (1줄)**' (규칙을 어길 때). 규칙마다 '왜'를 한 줄.\n\n표준 컨텍스트:\n${text}`,
  translate_ko_to_cherokee: (text) =>
    `Translate the Korean text below into natural Cherokee (ᏣᎳᎩ) — Iroquoian language of the Cherokee Nation, southeastern United States. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ᏣᎳᎩ**' and '**번역 노트**' (3 bullets in Korean — note Cherokee is written in the syllabary invented by Sequoyah).\n\n원문:\n${text}`,
  translate_ko_to_lakota: (text) =>
    `Translate the Korean text below into natural Lakota (Lakȟótiyapi) — Siouan language of the Lakota people, northern Great Plains, United States. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Lakȟótiyapi**' and '**번역 노트**' (3 bullets in Korean — note Lakota is a Siouan language written in a Latin-based orthography with nasal vowels).\n\n원문:\n${text}`,
  translate_ko_to_choctaw: (text) =>
    `Translate the Korean text below into natural Choctaw (Chahta anumpa) — Muskogean language of the Choctaw Nation, southeastern United States. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Chahta anumpa**' and '**번역 노트**' (3 bullets in Korean — note Choctaw is a Muskogean language; it contributed to the Chickasaw and Mobilian trade jargon).\n\n원문:\n${text}`,
  translate_ko_to_apache: (text) =>
    `Translate the Korean text below into natural Western Apache (Ndee biyáti') — Southern Athabaskan language of Arizona, United States. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ndee biyáti'**' and '**번역 노트**' (3 bullets in Korean — note Western Apache is a tonal Athabaskan language closely related to Navajo).\n\n원문:\n${text}`,
  translate_ko_to_hopi: (text) =>
    `Translate the Korean text below into natural Hopi (Hopilàvayi) — Uto-Aztecan language of the Hopi people, northeastern Arizona, United States. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hopilàvayi**' and '**번역 노트**' (3 bullets in Korean — note Hopi is a Uto-Aztecan language famous in linguistics for debates about its expression of time).\n\n원문:\n${text}`,
  internal_pr_faq_ko: (text) =>
    `Write a Korean PR/FAQ (Amazon-style working-backwards doc) — drafts a future press release plus FAQ to pressure-test an idea before building. Use 합쇼체. Markdown: '**보도자료**' ('**헤드라인**' 1줄 + '**부제**' 1줄 + 본문 3-4단락: 문제 / 솔루션 / 고객 인용 / 시작 방법 — 출시된 것처럼 과거형), '**고객 FAQ (bullets)**' (고객이 물을 질문 + 답), '**내부 FAQ (bullets)**' (어렵게 만드는 질문 — 비용 / 리스크 / 왜 우리 / 왜 지금), '**성공 지표 (bullets)**'. 미래에서 거꾸로 — 만들기 전에 가치 검증.\n\n아이디어 컨텍스트:\n${text}`,
  sales_pipeline_review_ko: (text) =>
    `Write a Korean pipeline review — reviews a rep's or team's pipeline health for forecasting. Use 합쇼체. Markdown: '**한 줄 (파이프라인)**' (1줄 — 건강도 + 커버리지 배수), '**단계별 분포 (테이블)**' ('단계 | 딜 수 | 금액 | 가중 금액'), '**이번 분기 예측 (1줄)**' (commit / best case / 목표 대비), '**리스크 딜 (bullets)**' (정체 / 슬립 위험), '**신규 유입 vs 필요 (1줄)**' (파이프라인 갭), '**막힌 패턴 (bullets)**' (어느 단계에서 자꾸), '**액션 (테이블)**' ('액션 | 딜/영역 | 담당'), '**코칭 포인트 (1줄)**'. 데이터 + 실행.\n\n파이프라인 컨텍스트:\n${text}`,
  customer_renewal_forecast_ko: (text) =>
    `Write a Korean renewal forecast — forecasts upcoming renewals with risk-adjusted probability. Use 합쇼체. Markdown: '**한 줄 (전망)**' (1줄 — 총 갱신액 + 가중 예상), '**갱신 목록 (테이블)**' ('계정 | ARR | 갱신일 | 헬스 | 확률 | 가중액'), '**카테고리 (bullets)**' (안전 / 주의 / 위험 — 각 합계), '**업셀/다운셀 전망 (1줄)**', '**핵심 리스크 딜 (bullets)**' (각 '계정 — 리스크 — 액션'), '**총계 (1줄)**' (gross / net 갱신율 예상), '**가정 (bullets)**' (예측 전제). 숫자 + 근거.\n\n갱신 데이터 컨텍스트:\n${text}`,
  pm_product_principles_ko: (text) =>
    `Write Korean product principles — a small set of durable principles that guide product decisions. Use 합쇼체. Markdown: '**한 줄 (왜 원칙)**' (1줄), '**원칙 (numbered)**' (3-6개, 각 '**원칙명 (1줄)**' + 설명 2-3줄 + '이럴 때 적용' 1줄 + 가능하면 트레이드오프 — 'A를 B보다 우선'), '**적용 예시 (bullets)**' (실제 결정에 어떻게), '**원칙이 아닌 것 (1줄)**' (슬로건과 구분). 트레이드오프를 담아 실제 결정에 쓰이게.\n\n제품 / 컨텍스트:\n${text}`,
  internal_incident_exec_summary_ko: (text) =>
    `Write a Korean incident executive summary — a brief for leadership after a significant incident. Use 합쇼체. 간결 + 사실 + 책임. Markdown: '**한 줄 (요약)**' (1줄 — 무슨 일 / 영향 / 현재 상태), '**비즈니스 영향 (bullets)**' (고객 / 매출 / 평판 — 수치), '**타임라인 (1줄)**' (감지 → 완화 → 해결, 소요 시간), '**근본 원인 (1-2줄)**' (비기술 언어로), '**잘 대응한 것 (1줄)**', '**재발 방지 핵심 (bullets)**' (3개 이내 — 가장 중요한 것), '**필요한 의사결정/투자 (1줄)**'. 임원이 30초에 파악 가능하게.\n\n인시던트 컨텍스트:\n${text}`,
  translate_ko_to_mixtec: (text) =>
    `Translate the Korean text below into natural Mixtec (Tu'un Savi) — Oto-Manguean language of Oaxaca, Guerrero and Puebla, Mexico. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tu'un Savi**' and '**번역 노트**' (3 bullets in Korean — note Mixtec is a tonal Oto-Manguean language with many regional varieties; pick a widely-understood standard).\n\n원문:\n${text}`,
  translate_ko_to_zapotec: (text) =>
    `Translate the Korean text below into natural Zapotec (Diidxazá) — Oto-Manguean language of Oaxaca, Mexico. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Diidxazá**' and '**번역 노트**' (3 bullets in Korean — note Zapotec is a tonal Oto-Manguean language; Isthmus Zapotec has a notable written literature).\n\n원문:\n${text}`,
  translate_ko_to_otomi: (text) =>
    `Translate the Korean text below into natural Otomi (Hñähñu) — Oto-Manguean language of central Mexico. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hñähñu**' and '**번역 노트**' (3 bullets in Korean — note Otomi is a tonal language of the central Mexican highlands with a complex vowel system).\n\n원문:\n${text}`,
  translate_ko_to_purepecha: (text) =>
    `Translate the Korean text below into natural Purépecha (P'urhépecha) — a language isolate of Michoacán, Mexico. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**P'urhépecha**' and '**번역 노트**' (3 bullets in Korean — note Purépecha is a language isolate with no proven relatives, language of the former Tarascan state).\n\n원문:\n${text}`,
  translate_ko_to_yucatec: (text) =>
    `Translate the Korean text below into natural Yucatec Maya (Maaya t'aan) — Mayan language of the Yucatán Peninsula, Mexico, and Belize. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Maaya t'aan**' and '**번역 노트**' (3 bullets in Korean — note Yucatec Maya is a tonal Mayan language written in Latin script, with ejective consonants).\n\n원문:\n${text}`,
  internal_design_doc_review_checklist_ko: (text) =>
    `Write a Korean design doc review checklist — guides a reviewer to give high-quality feedback on a design doc. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**문제 정의 (체크 bullets)**' (문제가 명확한가 / 왜 지금), '**목표 (체크 bullets)**' (측정 가능 / 비목표 명시), '**설계 (체크 bullets)**' (단순성 / 대안 검토 / 트레이드오프 명시), '**리스크 (체크 bullets)**' (실패 모드 / 보안 / 데이터), '**운영 (체크 bullets)**' (롤아웃 / 모니터링 / 롤백), '**리뷰 에티켓 (bullets)**' (질문으로 / 차단 vs 제안 구분), '**판정 (1줄)**' (승인 / 조건부 / 반려). 좋은 피드백 문화 강조.\n\n리뷰 컨텍스트:\n${text}`,
  sales_renewal_playbook_ko: (text) =>
    `Write a Korean renewal playbook — a repeatable process for managing renewals from early to close. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄), '**타임라인 (테이블)**' ('시점(갱신 D-X) | 활동 | 담당'): 보통 D-120/D-90/D-60/D-30/D-7, '**단계별 플레이 (bullets)**' (각 시점에 무엇을), '**리스크 신호 + 대응 (테이블)**', '**가치 재확인 (bullets)**' (데이터로), '**확장 기회 포착 (1줄)**', '**에스컬레이션 기준 (bullets)**', '**성공 지표 (bullets)**' (gross/net 갱신율). 조기 + 선제 강조.\n\n갱신 컨텍스트:\n${text}`,
  customer_quarterly_value_recap_ko: (text) =>
    `Write a Korean quarterly value recap — a short customer-facing recap of the value delivered this quarter. Use 합쇼체 (간결 + 데이터). Markdown: '**한 줄 (분기 가치)**' (1줄), '**핵심 성과 (bullets)**' (각 '지표 — 분기 변화 — 의미'), '**사용 하이라이트 (1줄)**', '**해결한 이슈 (1줄)**' (있으면), '**다음 분기 함께할 것 (bullets)**', '**한 줄 감사 (1줄)**'. 1분 안에 읽히게, 가치 입증 중심.\n\n분기 데이터 컨텍스트:\n${text}`,
  pm_feature_acceptance_criteria_ko: (text) =>
    `Write Korean acceptance criteria for a feature — defines exactly when a feature is 'done'. Use 합쇼체. Markdown: '**한 줄 (기능)**' (1줄), '**유저 스토리 (1줄)**' ('~로서 ~하고 싶다'), '**인수 기준 (Given/When/Then 형태 bullets)**' (각 시나리오: 주어진 상황 / 행동 / 기대 결과), '**엣지 케이스 (bullets)**' (빈 값 / 에러 / 권한 / 경계), '**비기능 기준 (bullets)**' (성능 / 접근성 / 보안), '**범위 밖 (bullets)**', '**완료 정의 (체크 bullets)**' (코드 / 테스트 / 문서 / 리뷰). 모호함 없이 검증 가능하게.\n\n기능 컨텍스트:\n${text}`,
  internal_oncall_rotation_policy_ko: (text) =>
    `Write a Korean on-call rotation policy — defines how on-call works for a team, fairly and sustainably. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**범위 (bullets)**' (어떤 서비스 / 시간대), '**로테이션 (bullets)**' (주기 / 인원 / primary·secondary), '**대응 기대치 (테이블)**' ('심각도 | 응답 시간 | 에스컬레이션'), '**보상 / 보호 (bullets)**' (수당 / 휴식 / 다음날 배려), '**핸드오프 (1줄)**' (교대 시 무엇을), '**에스컬레이션 경로 (bullets)**', '**번아웃 방지 (bullets)**' (알림 노이즈 / 공정 분배). 지속가능성 강조.\n\n온콜 정책 컨텍스트:\n${text}`,
  translate_ko_to_wayuu: (text) =>
    `Translate the Korean text below into natural Wayuu (Wayuunaiki) — Arawakan language of the Guajira Peninsula, Colombia and Venezuela. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Wayuunaiki**' and '**번역 노트**' (3 bullets in Korean — note Wayuunaiki is the most widely spoken indigenous language of Colombia and Venezuela's Guajira region).\n\n원문:\n${text}`,
  translate_ko_to_shipibo: (text) =>
    `Translate the Korean text below into natural Shipibo-Konibo — Panoan language of the Peruvian Amazon (Ucayali River). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Shipibo**' and '**번역 노트**' (3 bullets in Korean — note Shipibo is a Panoan language known for its kené geometric art tradition).\n\n원문:\n${text}`,
  translate_ko_to_kichwa: (text) =>
    `Translate the Korean text below into natural Kichwa — the Ecuadorian/northern Quechuan variety of the Andes and Amazon. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kichwa**' and '**번역 노트**' (3 bullets in Korean — note Kichwa is the northern Quechuan variety, distinct in orthography from southern Quechua).\n\n원문:\n${text}`,
  translate_ko_to_tupi: (text) =>
    `Translate the Korean text below into natural Nheengatu (Modern Tupí / Língua Geral Amazônica) — Tupi-Guarani language of the Brazilian Amazon. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Nheengatu**' and '**번역 노트**' (3 bullets in Korean — note Nheengatu descends from Old Tupi and was the lingua franca of colonial Amazonia).\n\n원문:\n${text}`,
  translate_ko_to_yanomami: (text) =>
    `Translate the Korean text below into natural Yanomami — a language of the Yanomaman family spoken in the Amazon on the Brazil-Venezuela border. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Yanomami**' and '**번역 노트**' (3 bullets in Korean — note Yanomami forms its own small language family with no proven outside relatives).\n\n원문:\n${text}`,
  internal_postmortem_5whys_ko: (text) =>
    `Run a Korean 5 Whys root cause analysis — drills from a symptom to a systemic root cause. Use 합쇼체. Markdown: '**문제 (1줄)**' (관찰된 증상), '**5 Whys (numbered)**' (Why 1 → 답 / Why 2 → 답 / ... 각 단계는 앞 답을 파고듦 — 사람이 아닌 시스템으로), '**근본 원인 (1줄)**' (마지막 답), '**기여 요인 (bullets)**' (단일 원인이 아닐 수 있음), '**대응 (테이블)**' ('원인 레벨 | 대응 액션 | 담당'): 증상 완화 vs 근본 해결 구분, '**검증 (1줄)**' (재발 안 함을 어떻게 확인), '**주의 (1줄)**' (5 Whys의 한계 — 단선적 사고 경계). 비난 없이.\n\n문제 컨텍스트:\n${text}`,
  sales_loss_recovery_plan_ko: (text) =>
    `Write a Korean loss recovery plan — a plan to re-engage a prospect or customer after a lost deal. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 무엇을 회복), '**왜 잃었나 (bullets)**' (솔직 — 가격 / 타이밍 / 경쟁 / 핏), '**회복 가능성 (1줄)**' (높음/중간/낮음 + 근거), '**전제 변화 (bullets)**' (다시 노릴 만한 트리거 — 우리 제품 변화 / 그들 상황 변화), '**재접근 전략 (numbered)**' (언제 / 어떤 각도 / 누구 통해), '**제공할 새 가치 (bullets)**', '**리스크 (1줄)**' (귀찮게 굴어 관계 악화), '**다음 액션 (테이블)**'. 관계 보존 + 타이밍.\n\n로스 컨텍스트:\n${text}`,
  customer_advocacy_program_ko: (text) =>
    `Design a Korean customer advocacy program — turns happy customers into advocates (references, reviews, case studies). Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄), '**어드보킷 식별 (bullets)**' (누가 후보 / 신호), '**어드보커시 단계 (테이블)**' ('단계 | 요청 | 부담도 | 보상'): 리뷰 → 레퍼런스 → 케이스스터디 → 스피킹, '**유인 / 보상 (bullets)**' (금전 아닌 것 포함 — 가시성 / 네트워킹 / 얼리액세스), '**운영 (bullets)**' (누가 관리 / 추적 방법), '**측정 (bullets)**' (어드보킷 수 / 활동 / 영향), '**주의 (1줄)**' (피로 / 진정성). 관계 우선.\n\n어드보커시 컨텍스트:\n${text}`,
  pm_release_retro_ko: (text) =>
    `Facilitate a Korean release retrospective — reviews how a product release went, end to end. Use 합쇼체. Markdown: '**한 줄 (릴리스)**' (1줄 — 전반 평가), '**목표 대비 (bullets)**' (계획 vs 실제 — 일정 / 범위 / 품질), '**잘된 것 (bullets)**', '**문제 (테이블)**' ('문제 | 영향 | 단계(계획/개발/QA/출시)'), '**고객 반응 (1줄)**', '**프로세스 교훈 (bullets)**' (반복 가능한), '**액션 아이템 (테이블)**' ('액션 | 담당 | 시한'), '**다음 릴리스에 바꿀 것 (1줄)**'. 시스템과 프로세스 관점.\n\n릴리스 retro 컨텍스트:\n${text}`,
  internal_team_ramp_plan_ko: (text) =>
    `Write a Korean new-hire ramp plan — a 30/60/90 day plan to get a new team member productive. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 90일 후 모습), '**30일 (bullets)**' (학습 — 사람 / 시스템 / 컨텍스트 + 작은 첫 기여), '**60일 (bullets)**' (기여 — 독립적으로 맡는 영역 확대), '**90일 (bullets)**' (주도 — 오너십 + 개선 제안), '**마일스톤 / 성공 기준 (테이블)**' ('시점 | 기대 | 측정'), '**지원 (bullets)**' (버디 / 멘토 / 체크인), '**리소스 (bullets)**', '**조기 경고 신호 (1줄)**'. 명확 + 점진적.\n\n신규 입사자 / 역할 컨텍스트:\n${text}`,
  translate_ko_to_iban: (text) =>
    `Translate the Korean text below into natural Iban — Austronesian language of Sarawak, Borneo (Malaysia). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Jaku Iban**' and '**번역 노트**' (3 bullets in Korean — note Iban is the largest indigenous language of Sarawak, a Malayic language written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_kadazan: (text) =>
    `Translate the Korean text below into natural Kadazan — Dusunic (Austronesian) language of Sabah, Borneo (Malaysia). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kadazan**' and '**번역 노트**' (3 bullets in Korean — note Kadazan is closely related to Dusun, spoken around Penampang in Sabah).\n\n원문:\n${text}`,
  translate_ko_to_dusun: (text) =>
    `Translate the Korean text below into natural Dusun (Central Dusun) — Dusunic (Austronesian) language of Sabah, Borneo (Malaysia). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Boros Dusun**' and '**번역 노트**' (3 bullets in Korean — note Dusun forms a dialect continuum with Kadazan, collectively called Kadazandusun).\n\n원문:\n${text}`,
  translate_ko_to_murut: (text) =>
    `Translate the Korean text below into natural Murut — Austronesian language group of interior Sabah and Sarawak, Borneo. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Murut**' and '**번역 노트**' (3 bullets in Korean — note Murut refers to a cluster of related languages of Borneo's interior highlands).\n\n원문:\n${text}`,
  translate_ko_to_bidayuh: (text) =>
    `Translate the Korean text below into natural Bidayuh — Land Dayak (Austronesian) language of Sarawak, Borneo (Malaysia). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Bidayuh**' and '**번역 노트**' (3 bullets in Korean — note Bidayuh is a Land Dayak language cluster of southwestern Sarawak).\n\n원문:\n${text}`,
  internal_eng_metrics_review_ko: (text) =>
    `Write a Korean engineering metrics review — reviews delivery/quality metrics (e.g., DORA) for a team. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 건강도 + 핵심 추세), '**핵심 지표 (테이블)**' ('지표 | 현재 | 추세 | 벤치마크'): 배포 빈도 / 변경 리드타임 / 변경 실패율 / 복구 시간(MTTR), '**잘 되는 것 (bullets)**', '**악화 / 우려 (bullets)**' (각 '지표 — 가능한 원인'), '**병목 (1단락)**', '**개선 액션 (테이블)**' ('액션 | 기대 효과 | 담당'), '**주의 (1줄)**' (지표 게이밍 / 맥락 무시 경계). 지표는 대화의 시작점.\n\n지표 컨텍스트:\n${text}`,
  sales_champion_enablement_ko: (text) =>
    `Write a Korean champion enablement kit — equips an internal champion to sell on your behalf. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 챔피언이 내부에서 무엇을 할 수 있게), '**챔피언 프로필 (1줄)**' (누구 / 영향력), '**그들이 필요한 것 (bullets)**' (논거 / 자료 / 답변), '**핵심 메시지 (bullets)**' (챔피언이 전달할 1줄들), '**예상 내부 반론 + 대응 (테이블)**', '**제공 자료 (bullets)**' (ROI 시트 / 덱 / 데모), '**다음 단계 코칭 (1줄)**' (그들이 다음에 할 일), '**우리 지원 (1줄)**'. 챔피언을 영웅으로 만들기.\n\n챔피언 컨텍스트:\n${text}`,
  customer_onboarding_retrospective_ko: (text) =>
    `Facilitate a Korean onboarding retrospective — reviews how a customer's onboarding went to improve the next. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — TTV 달성 여부 + 핵심), '**목표 대비 (bullets)**' (계획 일정/마일스톤 vs 실제), '**잘된 것 (bullets)**', '**막혔던 것 (테이블)**' ('지점 | 원인 | 영향'), '**고객 피드백 (bullets)**' (그들 언어로), '**Time-to-value (1줄)**' (얼마 걸렸나 / 목표 대비), '**프로세스 개선 (테이블)**' ('교훈 | 액션 | 담당'), '**플레이북 업데이트 (1줄)**'. 다음 고객을 위한 학습.\n\n온보딩 retro 컨텍스트:\n${text}`,
  pm_beta_program_plan_ko: (text) =>
    `Write a Korean beta program plan — plans a structured beta to validate a feature before GA. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 무엇을 검증), '**가설 / 학습 목표 (bullets)**', '**참가자 (bullets)**' (누구 / 몇 명 / 선정 기준), '**범위 (bullets)**' (베타에 무엇이 / 무엇이 빠짐), '**일정 (테이블)**' ('단계 | 기간 | 활동'), '**성공 기준 (테이블)**' ('지표 | 목표'), '**피드백 수집 (bullets)**' (방법 / 빈도), '**리스크 (bullets)**', '**GA 진입 기준 (1줄)**'. 학습 중심 설계.\n\n베타 컨텍스트:\n${text}`,
  internal_alert_triage_guide_ko: (text) =>
    `Write a Korean alert triage guide — helps on-call quickly assess and act on an alert. Use 합쇼체. Markdown: '**한 줄 (알림)**' (1줄 — 무슨 알림 / 무엇을 뜻하나), '**즉시 확인 (numbered)**' (가장 먼저 볼 것 — 대시보드 / 로그 / 영향 범위), '**심각도 판단 (테이블)**' ('관찰 | 심각도 | 의미'), '**대응 (bullets)**' (심각도별 첫 액션), '**흔한 원인 (테이블)**' ('증상 | 가능 원인 | 확인 방법'), '**완화 (bullets)**' (임시 조치), '**에스컬레이션 (1줄)**' (언제 / 누구), '**오탐 처리 (1줄)**' (노이즈면). 빠른 판단 우선.\n\n알림 컨텍스트:\n${text}`,
  translate_ko_to_toba_batak: (text) =>
    `Translate the Korean text below into natural Toba Batak — Austronesian language of the Lake Toba region, North Sumatra, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Batak Toba**' and '**번역 노트**' (3 bullets in Korean — note Toba Batak has its own traditional Batak script, now usually written in Latin).\n\n원문:\n${text}`,
  translate_ko_to_nias: (text) =>
    `Translate the Korean text below into natural Nias (Li Niha) — Austronesian language of Nias island off western Sumatra, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Li Niha**' and '**번역 노트**' (3 bullets in Korean — note Nias is unusual among Austronesian languages for having only open syllables).\n\n원문:\n${text}`,
  translate_ko_to_mentawai: (text) =>
    `Translate the Korean text below into natural Mentawai — Austronesian language of the Mentawai Islands off western Sumatra, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Mentawai**' and '**번역 노트**' (3 bullets in Korean — note Mentawai is spoken by the indigenous people of the Mentawai archipelago).\n\n원문:\n${text}`,
  translate_ko_to_rejang: (text) =>
    `Translate the Korean text below into natural Rejang — Austronesian language of the Bengkulu highlands, Sumatra, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Rejang**' and '**번역 노트**' (3 bullets in Korean — note Rejang has its own traditional KaGaNga (Surat Ulu) script).\n\n원문:\n${text}`,
  translate_ko_to_lampung: (text) =>
    `Translate the Korean text below into natural Lampung — Austronesian language of Lampung province, southern Sumatra, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Lampung**' and '**번역 노트**' (3 bullets in Korean — note Lampung has its own Lampung (Kaganga) script and two main dialects, Api and Nyo).\n\n원문:\n${text}`,
  internal_dependency_map_ko: (text) =>
    `Write a Korean dependency map — surfaces cross-team/system dependencies that could block delivery. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 무엇을 위한 의존성 맵), '**우리가 의존하는 것 (테이블)**' ('의존 대상 | 무엇이 필요 | 담당 팀 | 시한 | 상태/리스크'), '**우리에게 의존하는 것 (테이블)**' ('누가 | 무엇을 기다림 | 시한'), '**임계 경로 (1줄)**' (가장 빡빡한 체인), '**리스크 (bullets)**' (각 '의존성 — 지연 시 영향 — 완화'), '**조정 필요 (bullets)**' (누구와 무엇을 합의), '**다음 액션 (테이블)**'. 블로커 가시화 중심.\n\n의존성 컨텍스트:\n${text}`,
  sales_enablement_one_pager_ko: (text) =>
    `Write a Korean sales enablement one-pager — a single-page reference that helps reps sell a product/feature. Use 합쇼체. 1페이지, 스캔 가능. Markdown: '**한 줄 (무엇/누구)**' (1줄), '**고객 페인 (bullets)**' (이게 해결하는 것), '**핵심 가치 (bullets)**' (각 '가치 — 한 줄 증거'), '**대상 / 자격 질문 (bullets)**' (좋은 핏 판별), '**경쟁 차별점 (1줄)**', '**대표 반론 + 응답 (테이블)**', '**데모/말할 포인트 (bullets)**', '**다음 단계 (1줄)**'. 영업이 5분 안에 흡수 가능하게.\n\n인에이블먼트 컨텍스트:\n${text}`,
  customer_renewal_checklist_ko: (text) =>
    `Write a Korean renewal checklist — a step-by-step checklist to execute a clean renewal. Use 합쇼체. Markdown: '**한 줄 (갱신)**' (1줄 — 계정 / 갱신일 / ARR), '**D-90 (체크 bullets)**' (헬스 점검 / 챔피언 확인 / 가치 데이터 수집), '**D-60 (체크 bullets)**' (가치 리뷰 미팅 / 갱신 의향 확인), '**D-30 (체크 bullets)**' (제안 / 가격 / 계약 시작), '**D-7 (체크 bullets)**' (서명 / 승인 / 결제 확인), '**리스크 플래그 (bullets)**' (즉시 에스컬레이션 신호), '**갱신 후 (체크 bullets)**' (확인 / 다음 사이클 준비). 빠짐없이 실행.\n\n갱신 컨텍스트:\n${text}`,
  pm_market_sizing_ko: (text) =>
    `Write a Korean market sizing analysis — estimates TAM/SAM/SOM for an opportunity. Use 합쇼체. Markdown: '**한 줄 (기회 규모)**' (1줄 — 핵심 숫자 + 신뢰도), '**TAM (1단락)**' (전체 시장 — 계산 방식 + 가정), '**SAM (1단락)**' (우리가 도달 가능한 부분), '**SOM (1단락)**' (현실적 점유 — 단기), '**계산 (테이블)**' ('항목 | 값 | 출처/가정'), '**Top-down vs Bottom-up (1줄)**' (교차 검증), '**민감도 (bullets)**' (핵심 가정이 바뀌면), '**결론 (1줄)**' (추구할 가치가 있나). 가정을 투명하게.\n\n시장 컨텍스트:\n${text}`,
  internal_escalation_policy_ko: (text) =>
    `Write a Korean escalation policy — defines when and how to escalate issues. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**언제 에스컬레이션 (bullets)**' (트리거 — 심각도 / 시간 / 영향 기준), '**경로 (테이블)**' ('심각도 | 누구에게 | 채널 | 응답 기대'), '**에스컬레이션 방법 (bullets)**' (무슨 정보를 담아 — 상황/영향/필요), '**역할 (bullets)**' (누가 결정 / 누가 소통), '**되돌리기 (1줄)**' (해결 후 디에스컬레이션), '**안티패턴 (1줄)**' (너무 늦게 / 정보 없이 에스컬레이션). 빠르고 비난 없이.\n\n에스컬레이션 컨텍스트:\n${text}`,
  translate_ko_to_sasak: (text) =>
    `Translate the Korean text below into natural Sasak — Austronesian language of Lombok island, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Sasak**' and '**번역 노트**' (3 bullets in Korean — note Sasak is closely related to Balinese and has speech levels influenced by Balinese and Javanese).\n\n원문:\n${text}`,
  translate_ko_to_bima: (text) =>
    `Translate the Korean text below into natural Bima (Nggahi Mbojo) — Austronesian language of eastern Sumbawa, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Nggahi Mbojo**' and '**번역 노트**' (3 bullets in Korean — note Bima is the language of the Mbojo people of eastern Sumbawa).\n\n원문:\n${text}`,
  translate_ko_to_manggarai: (text) =>
    `Translate the Korean text below into natural Manggarai — Austronesian language of western Flores, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Manggarai**' and '**번역 노트**' (3 bullets in Korean — note Manggarai is the most widely spoken language of western Flores).\n\n원문:\n${text}`,
  translate_ko_to_sumbawa: (text) =>
    `Translate the Korean text below into natural Sumbawa (Basa Samawa) — Austronesian language of western Sumbawa, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Basa Samawa**' and '**번역 노트**' (3 bullets in Korean — note Sumbawa language is related to Sasak and Balinese, distinct from Bima to its east).\n\n원문:\n${text}`,
  translate_ko_to_ngada: (text) =>
    `Translate the Korean text below into natural Ngada — Austronesian language of central Flores, Indonesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ngada**' and '**번역 노트**' (3 bullets in Korean — note Ngada is spoken in the Bajawa highlands of central Flores).\n\n원문:\n${text}`,
  internal_release_comms_internal_ko: (text) =>
    `Write a Korean internal release communication — tells the company what's shipping and what each team needs to do. Use 합쇼체. Markdown: '**한 줄 (릴리스)**' (1줄 — 무엇이 / 언제), '**무엇이 바뀌나 (bullets)**' (사용자/고객 관점), '**팀별 할 일 (테이블)**' ('팀 | 해야 할 것 | 시한'): Support / Sales / Marketing / CS, '**알아둘 점 (bullets)**' (주의 / 마이그레이션 / 알려진 이슈), '**FAQ 링크 / 자료 (bullets)**', '**문의 (1줄)**' (누구에게), '**타임라인 (1줄)**'. 내부 정렬 + 명확한 액션.\n\n릴리스 컨텍스트:\n${text}`,
  sales_account_handoff_ko: (text) =>
    `Write a Korean account handoff doc — hands an account from Sales to CS (or between reps) cleanly. Use 합쇼체. Markdown: '**한 줄 (계정)**' (1줄 — 누구 / 규모 / 단계), '**거래 배경 (1단락)**' (왜 샀나 / 기대), '**핵심 연락처 (테이블)**' ('이름 | 역할 | 영향력 | 관계 메모'), '**구매 동기 / 성공 기준 (bullets)**' (그들이 정의한 성공), '**약속한 것 (bullets)**' (영업이 한 약속 — 명확히), '**리스크 / 주의 (bullets)**', '**즉시 할 일 (bullets)**' (첫 30일), '**히스토리 링크 (1줄)**'. CS가 첫날부터 맥락 갖게.\n\n핸드오프 컨텍스트:\n${text}`,
  customer_expansion_proposal_ko: (text) =>
    `Write a Korean expansion proposal — proposes upsell/cross-sell to an existing customer based on value. Use 합쇼체. Markdown: '**한 줄 (제안)**' (1줄 — 무엇을 추가 / 왜 지금), '**현재 성과 (bullets)**' (이미 얻은 가치 — 데이터), '**기회 (1단락)**' (확장이 풀어줄 새 가치 / 고객 목표 연결), '**제안 패키지 (테이블)**' ('항목 | 내용 | 가격'), '**기대 효과 (bullets)**' (정량 + 정성), '**ROI (1줄)**', '**도입 경로 (1줄)**' (얼마나 쉽게), '**다음 단계 (1줄)**'. 압박 아닌 가치 확장.\n\n확장 컨텍스트:\n${text}`,
  pm_concept_validation_ko: (text) =>
    `Write a Korean concept validation plan — designs a lightweight test to validate a product concept before building. Use 합쇼체. Markdown: '**한 줄 (컨셉)**' (1줄 — 무엇을 검증), '**핵심 가정 (bullets)**' (틀리면 안 되는 믿음 — 위험순), '**검증 방법 (테이블)**' ('가정 | 검증 방법(인터뷰/랜딩/프로토/위저드오즈) | 성공 신호'), '**최소 실험 (1단락)**' (가장 싸게 가장 위험한 가정부터), '**측정 (bullets)**', '**의사결정 기준 (bullets)**' ('이러면 진행 / 이러면 피벗 / 이러면 중단'), '**기간 / 비용 (1줄)**'. 만들기 전에 배우기.\n\n컨셉 컨텍스트:\n${text}`,
  internal_decision_framework_ko: (text) =>
    `Write a Korean decision-making framework doc — clarifies how a specific decision will be made. Use 합쇼체. Markdown: '**한 줄 (결정)**' (1줄 — 무엇을 결정), '**왜 프레임워크 (1줄)**' (왜 명확화 필요), '**의사결정 모델 (1줄)**' (합의 / 자문후결정 / RAPID / 위임 등 — 무엇을 쓰는지), '**역할 (테이블)**' ('역할 | 누구 | 권한'): 추천 / 자문 / 결정 / 실행, '**기준 (bullets)**' (무엇으로 옵션 평가), '**프로세스 (numbered)**' (옵션 수집 → 평가 → 결정 → 공유), '**시한 (1줄)**', '**되돌릴 수 있나 (1줄)**' (가역성 → 신중도 조절). 빠르고 명확한 결정.\n\n결정 컨텍스트:\n${text}`,
  translate_ko_to_hokkien: (text) =>
    `Translate the Korean text below into natural Hokkien (Min Nan / Taiwanese) — Southern Min Sinitic language of Fujian, Taiwan and the diaspora. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hokkien**' (Han characters with POJ/Tâi-lô romanization where helpful) and '**번역 노트**' (3 bullets in Korean — note Hokkien preserves features lost in Mandarin and has literary/colloquial readings).\n\n원문:\n${text}`,
  translate_ko_to_hakka: (text) =>
    `Translate the Korean text below into natural Hakka — Sinitic language of scattered Hakka communities across southern China, Taiwan and Southeast Asia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hakka**' (Han characters with Pha̍k-fa-sṳ romanization where helpful) and '**번역 노트**' (3 bullets in Korean — note Hakka is a distinct Sinitic branch, not mutually intelligible with Mandarin).\n\n원문:\n${text}`,
  translate_ko_to_cantonese: (text) =>
    `Translate the Korean text below into natural Cantonese (粵語) — Yue Sinitic language of Guangdong, Hong Kong and Macau. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**粵語**' (traditional Han characters with Jyutping where helpful) and '**번역 노트**' (3 bullets in Korean — note Cantonese has six tones and colloquial characters not used in Standard Chinese).\n\n원문:\n${text}`,
  translate_ko_to_teochew: (text) =>
    `Translate the Korean text below into natural Teochew (潮州話) — Southern Min Sinitic language of the Chaoshan region, eastern Guangdong. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Teochew**' (Han characters with Peng'im romanization where helpful) and '**번역 노트**' (3 bullets in Korean — note Teochew is a conservative Southern Min variety, distinct from Hokkien though related).\n\n원문:\n${text}`,
  translate_ko_to_okinawan: (text) =>
    `Translate the Korean text below into natural Okinawan (Uchinaaguchi) — a Ryukyuan (Japonic) language of Okinawa, Japan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Uchinaaguchi**' and '**번역 노트**' (3 bullets in Korean — note Okinawan is a Ryukyuan language, related to but not mutually intelligible with Japanese).\n\n원문:\n${text}`,
  internal_war_room_notes_ko: (text) =>
    `Structure Korean war room notes — live notes for coordinating a high-severity incident response. Use 합쇼체. 실시간 + 사실 위주. Markdown: '**한 줄 (상황)**' (1줄 — 심각도 + 영향 + 현재 상태), '**역할 (테이블)**' ('역할 | 누구'): IC / 커뮤니케이션 / 운영 / 기록, '**타임라인 (테이블)**' ('시각 | 사건/조치 | 누가'), '**현재 가설 (bullets)**' (확인/배제), '**진행 중 액션 (테이블)**' ('액션 | 담당 | 상태'), '**고객/내부 커뮤니케이션 (1줄)**' (마지막 / 다음), '**의사결정 대기 (bullets)**', '**다음 동기화 (1줄)**'. 실시간 갱신 전제.\n\n인시던트 컨텍스트:\n${text}`,
  sales_qualification_notes_ko: (text) =>
    `Structure Korean sales qualification notes — qualifies an opportunity using a framework like BANT/MEDDIC. Use 합쇼체. Markdown: '**한 줄 (자격)**' (1줄 — 추구 / 보류 / 폐기 + 이유), '**BANT (테이블)**' ('요소 | 상태 | 메모'): Budget / Authority / Need / Timeline, '**페인 (bullets)**' (구체적 — 비용 / 긴급도), '**의사결정 구조 (1줄)**' (누가 / 어떻게), '**경쟁 / 대안 (1줄)**', '**리스크 / 미지수 (bullets)**', '**다음 단계 (테이블)**' ('액션 | 담당 | 시한'), '**자격 점수 (1줄)**'. 솔직한 평가로 시간 낭비 방지.\n\n자격 컨텍스트:\n${text}`,
  customer_renewal_business_case_ko: (text) =>
    `Write a Korean renewal business case — gives a customer's internal champion the case to justify renewing. Use 합쇼체. Markdown: '**한 줄 (요지)**' (1줄 — 왜 갱신해야 하나), '**지난 기간 ROI (테이블)**' ('투자 | 효과 | 순가치'), '**핵심 성과 (bullets)**' (데이터 + 비즈니스 임팩트), '**갱신 안 할 경우 (bullets)**' (잃는 것 / 전환 비용), '**미래 가치 (bullets)**' (앞으로 얻을 것 / 로드맵), '**투자 (1줄)**' (갱신 비용), '**한 줄 결론 (1줄)**' (챔피언이 임원에게 할 말). 챔피언이 그대로 쓸 수 있게.\n\n갱신 컨텍스트:\n${text}`,
  pm_feature_kpi_definition_ko: (text) =>
    `Write a Korean feature KPI definition — defines how to measure whether a shipped feature succeeded. Use 합쇼체. Markdown: '**한 줄 (기능)**' (1줄 — 무엇을 / 어떤 성공), '**성공 가설 (1줄)**', '**핵심 지표 (테이블)**' ('지표 | 정의 | 베이스라인 | 목표 | 측정 시점'), '**선행 지표 (bullets)**' (채택 / 활성화), '**후행 지표 (bullets)**' (리텐션 / 매출 영향), '**가드레일 (bullets)**' (악화되면 안 되는 것), '**측정 방법 (1줄)**' (이벤트 / 출처), '**판정 기준 (1줄)**' (성공/실패를 언제 어떻게). 활동이 아닌 결과 측정.\n\n기능 컨텍스트:\n${text}`,
  internal_sprint_demo_notes_ko: (text) =>
    `Structure Korean sprint demo (review) notes — captures what was shown and feedback at a sprint review. Use 합쇼체. Markdown: '**한 줄 (스프린트)**' (1줄 — 무엇을 데모), '**보여준 것 (테이블)**' ('항목 | 누가 | 상태(완료/부분) | 피드백'), '**잘 받은 것 (bullets)**', '**우려 / 변경 요청 (bullets)**', '**미완 / 캐리오버 (bullets)**' (이유), '**이해관계자 피드백 (bullets)**' (출처 표기), '**액션 아이템 (테이블)**' ('액션 | 담당 | 시한'), '**다음 스프린트 시사점 (1줄)**'. 데모 → 학습 → 액션.\n\n데모 컨텍스트:\n${text}`,
  translate_ko_to_kashubian: (text) =>
    `Translate the Korean text below into natural Kashubian (Kaszëbsczi) — West Slavic language of the Pomerania region, northern Poland. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kaszëbsczi**' and '**번역 노트**' (3 bullets in Korean — note Kashubian is a West Slavic language related to Polish, written in Latin script with extra diacritics).\n\n원문:\n${text}`,
  translate_ko_to_silesian: (text) =>
    `Translate the Korean text below into natural Silesian (ślōnskŏ gŏdka) — West Slavic lect of Upper Silesia, southern Poland. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ślōnskŏ gŏdka**' and '**번역 노트**' (3 bullets in Korean — note Silesian is debated as a language vs. Polish dialect; it has German loanwords from the region's history).\n\n원문:\n${text}`,
  translate_ko_to_rusyn: (text) =>
    `Translate the Korean text below into natural Rusyn — East Slavic language of the Carpathian region (Slovakia, Ukraine, Poland, Serbia). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Русиньскый**' and '**번역 노트**' (3 bullets in Korean — note Rusyn is an East Slavic language written in Cyrillic, recognized as a minority language in several countries).\n\n원문:\n${text}`,
  translate_ko_to_sami_northern: (text) =>
    `Translate the Korean text below into natural Northern Sami (Davvisámegiella) — Uralic (Sámi) language of northern Norway, Sweden and Finland. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Davvisámegiella**' and '**번역 노트**' (3 bullets in Korean — note Northern Sami is the most widely spoken Sámi language, written in Latin with special letters like č, đ, ŋ, š, ŧ, ž).\n\n원문:\n${text}`,
  translate_ko_to_voro: (text) =>
    `Translate the Korean text below into natural Võro — a Finnic language of southeastern Estonia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Võro kiil**' and '**번역 노트**' (3 bullets in Korean — note Võro is a South Estonian Finnic variety with its own literary tradition, distinct from standard Estonian).\n\n원문:\n${text}`,
  internal_status_report_exec_ko: (text) =>
    `Write a Korean executive status report — a concise project status for leadership. Use 합쇼체. 한 화면에 들어오게. Markdown: '**한 줄 (상태)**' (1줄 — 🟢/🟡/🔴 + 핵심), '**진척 (1줄)**' (목표 대비 % / 마일스톤), '**이번 기간 성과 (bullets)**' (결과 중심 — 3개 이내), '**리스크 / 이슈 (테이블)**' ('이슈 | 영향 | 대응 | 필요 결정'), '**의사결정/지원 요청 (bullets)**' (임원이 해줄 것), '**다음 마일스톤 (1줄)**', '**예산/일정 (1줄)**'. 임원 시간 존중 — 액션 중심.\n\n프로젝트 컨텍스트:\n${text}`,
  sales_renewal_email_sequence_ko: (text) =>
    `Write a Korean renewal email sequence — a 3-email sequence leading up to a renewal date. Use 합쇼체 (따뜻 + 명확). Markdown: '**시퀀스 목표 (1줄)**', '**이메일 1 — 가치 리마인드 (D-60)**' ('제목:' + 본문 4-5줄: 성과 데이터 + 갱신 다가옴 안내 + 가벼운 논의 제안), '**이메일 2 — 제안 (D-30)**' (구체적 갱신 옵션 + 미래 가치), '**이메일 3 — 마무리 (D-7)**' (간단 리마인드 + 도움 제안 + 다음 단계), '**팁 (2 bullets)**' (타이밍 / 개인화). 각 이메일 100단어 이내, 압박 없이.\n\n갱신 컨텍스트:\n${text}`,
  customer_business_outcomes_review_ko: (text) =>
    `Write a Korean business outcomes review — ties product usage to the customer's actual business outcomes. Use 합쇼체. Markdown: '**한 줄 (성과)**' (1줄 — 비즈니스 임팩트 한 문장), '**고객 비즈니스 목표 (bullets)**' (그들이 추구하는 결과), '**우리 기여 (테이블)**' ('비즈니스 목표 | 우리 제품의 역할 | 측정된 결과'), '**정량 성과 (bullets)**' (매출 / 비용 / 시간 — 출처), '**정성 성과 (bullets)**', '**아직 미달 (bullets)**' (기회), '**다음 단계 (1줄)**', '**한 줄 요약 (1줄)**' (임원용). 제품 지표가 아닌 비즈니스 결과 중심.\n\n성과 컨텍스트:\n${text}`,
  pm_assumption_log_ko: (text) =>
    `Write a Korean assumption log — makes a project's assumptions explicit and trackable. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**가정 목록 (테이블)**' ('ID | 가정 | 근거 | 확신도(상/중/하) | 틀릴 경우 영향 | 검증 방법 | 상태'), '**검증 우선순위 (bullets)**' (영향 큰데 확신 낮은 것 먼저), '**검증된 / 깨진 가정 (bullets)**' (있으면), '**모니터링 (1줄)**' (언제 재검토), '**주의 (1줄)**' (암묵적 가정도 적기). 위험한 가정을 빛으로.\n\n가정 컨텍스트:\n${text}`,
  internal_meeting_action_tracker_ko: (text) =>
    `Build a Korean meeting action tracker — turns recurring-meeting action items into a tracked, accountable list. Use 합쇼체. Markdown: '**한 줄 (회의)**' (1줄 — 어떤 정기 회의), '**열린 액션 (테이블)**' ('ID | 액션 | 담당 | 생성일 | 시한 | 상태'), '**이번 회의 신규 (bullets)**', '**완료된 것 (bullets)**' (이번에 닫힌), '**지연/막힌 것 (테이블)**' ('액션 | 왜 지연 | 필요'), '**오래된 항목 점검 (1줄)**' (30일+ 미완), '**다음 점검 (1줄)**'. 책임 + 추적성 강조.\n\n액션 트래킹 컨텍스트:\n${text}`,
  translate_ko_to_low_german: (text) =>
    `Translate the Korean text below into natural Low German (Plattdüütsch) — a West Germanic language of northern Germany and the eastern Netherlands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Plattdüütsch**' and '**번역 노트**' (3 bullets in Korean — note Low German is distinct from Standard High German, lacking the High German consonant shift).\n\n원문:\n${text}`,
  translate_ko_to_limburgish: (text) =>
    `Translate the Korean text below into natural Limburgish (Lèmburgs) — a Low Franconian language of the Limburg region (Netherlands, Belgium, Germany). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Lèmburgs**' and '**번역 노트**' (3 bullets in Korean — note Limburgish is tonal, unusual among Germanic languages).\n\n원문:\n${text}`,
  translate_ko_to_picard: (text) =>
    `Translate the Korean text below into natural Picard (Ch'ti) — a Romance (Oïl) language of northern France and Wallonia, Belgium. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Picard**' and '**번역 노트**' (3 bullets in Korean — note Picard is a langue d'oïl closely related to French but distinct, popularly called Ch'ti).\n\n원문:\n${text}`,
  translate_ko_to_norman: (text) =>
    `Translate the Korean text below into natural Norman (Normaund) — a Romance (Oïl) language of Normandy and the Channel Islands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Normaund**' and '**번역 노트**' (3 bullets in Korean — note Norman is a langue d'oïl; Jèrriais and Guernésiais are its Channel Island varieties).\n\n원문:\n${text}`,
  translate_ko_to_gascon: (text) =>
    `Translate the Korean text below into natural Gascon — an Occitano-Romance variety of southwestern France. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Gascon**' and '**번역 노트**' (3 bullets in Korean — note Gascon is a distinctive Occitan variety with features attributed to an Aquitanian/Basque substrate).\n\n원문:\n${text}`,
  internal_okr_grading_ko: (text) =>
    `Write a Korean OKR grading (end-of-cycle scoring) — scores OKRs at the end of a cycle and extracts learning. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 전반 달성 + 핵심 교훈), '**Objective (1줄)**', '**KR 채점 (테이블)**' ('KR | 목표 | 실제 | 점수(0.0-1.0) | 코멘트'), '**잘 달성한 것 (bullets)**' (왜 됐나), '**미달한 것 (bullets)**' (왜 안 됐나 — 솔직), '**점수 해석 (1줄)**' (0.7이 이상적인 이유 / 1.0은 목표가 낮았던 것), '**교훈 (bullets)**' (다음 사이클에), '**캐리오버 / 종료 (1줄)**'. 점수보다 학습 강조.\n\nOKR 결과 컨텍스트:\n${text}`,
  sales_post_demo_email_ko: (text) =>
    `Draft a Korean post-demo follow-up email — sent right after a product demo to keep momentum. Use 합쇼체 (간결 + 가치). Markdown: '**제목**' (1줄), '**본문**' (3-4 단락: 1) 시간 감사 + 데모 핵심 1줄 요약, 2) 그들의 페인에 우리가 어떻게 맞는지 1-2줄 — 데모에서 본 것 연결, 3) 약속한 자료/답변 + 다음 단계 명확히, 4) 가벼운 CTA — 다음 미팅 제안), '**첨부 제안 (bullets)**' (덱 / 녹화 / ROI), '**다음 단계 (1줄)**'. 100단어 이내, 압박 없이.\n\n데모 컨텍스트:\n${text}`,
  customer_risk_mitigation_plan_ko: (text) =>
    `Write a Korean customer risk mitigation plan — a focused plan to rescue an at-risk account. Use 합쇼체. Markdown: '**한 줄 (리스크)**' (1줄 — 무슨 리스크 / 심각도), '**상황 (1단락)**' (어쩌다 여기까지 — 사실), '**리스크 요인 (테이블)**' ('요인 | 신호 | 심각도'), '**근본 우려 (1줄)**' (고객의 진짜 걱정), '**완화 액션 (테이블)**' ('액션 | 목표 | 담당 | 시한'), '**필요 자원 (bullets)**' (임원 후원 / 제품 / 크레딧), '**성공 신호 (bullets)**' (회복됐다는 증거), '**에스컬레이션 (1줄)**', '**체크인 리듬 (1줄)**'. 신속 + 구체.\n\n리스크 컨텍스트:\n${text}`,
  pm_feature_rollout_comms_ko: (text) =>
    `Write Korean feature rollout communications — coordinates internal+external messaging for a feature rollout. Use 합쇼체. Markdown: '**한 줄 (롤아웃)**' (1줄 — 무슨 기능 / 누구에게 / 언제), '**대상별 메시지 (테이블)**' ('대상 | 핵심 메시지 | 채널 | 시점'): 내부 / 기존고객 / 신규 / 미디어, '**단계별 공지 (numbered)**' (티저 → 출시 → 후속), '**인앱/이메일 카피 (bullets)**' (핵심 카피 초안), '**FAQ 핵심 (bullets)**', '**지원팀 브리핑 (1줄)**', '**측정 (bullets)**' (인지 / 채택). 일관된 메시지 강조.\n\n롤아웃 컨텍스트:\n${text}`,
  internal_eng_oncall_review_ko: (text) =>
    `Write a Korean on-call review — reviews a past on-call period to reduce toil and improve health. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 부담 정도 + 핵심), '**알림 통계 (테이블)**' ('지표 | 값'): 총 페이지 / 야간 페이지 / 실행불요(오탐)% / 평균 대응시간, '**가장 시끄러운 알림 (bullets)**' (각 '알림 — 빈도 — 조치'), '**반복 이슈 (bullets)**' (근본 해결 후보), '**오탐 정리 (bullets)**' (튜닝/삭제할 알림), '**번아웃 신호 (1줄)**', '**개선 액션 (테이블)**' ('액션 | 기대 | 담당'), '**다음 검토 (1줄)**'. toil 감소 중심.\n\n온콜 데이터 컨텍스트:\n${text}`,
  translate_ko_to_sorani: (text) =>
    `Translate the Korean text below into natural Sorani Kurdish (کوردیی ناوەندی) — Central Kurdish of Iraqi Kurdistan and western Iran. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**سۆرانی**' and '**번역 노트**' (3 bullets in Korean — note Sorani is written in an Arabic-derived alphabet, right-to-left, distinct from Kurmanji's Latin script).\n\n원문:\n${text}`,
  translate_ko_to_kurmanji: (text) =>
    `Translate the Korean text below into natural Kurmanji Kurdish (Kurmancî) — Northern Kurdish of Turkey, Syria and northern Iraq. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kurmancî**' and '**번역 노트**' (3 bullets in Korean — note Kurmanji is the most widely spoken Kurdish variety, written in a Latin-based alphabet).\n\n원문:\n${text}`,
  translate_ko_to_zazaki: (text) =>
    `Translate the Korean text below into natural Zazaki (Zazakî) — a Northwestern Iranian language of eastern Turkey. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Zazakî**' and '**번역 노트**' (3 bullets in Korean — note Zazaki is an Iranian language distinct from Kurdish, written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_gilaki: (text) =>
    `Translate the Korean text below into natural Gilaki — a Caspian (Northwestern Iranian) language of Gilan province, northern Iran. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Gilaki**' and '**번역 노트**' (3 bullets in Korean — note Gilaki is spoken along the Caspian Sea coast, usually written in Perso-Arabic script).\n\n원문:\n${text}`,
  translate_ko_to_mazandarani: (text) =>
    `Translate the Korean text below into natural Mazandarani (مازرونی) — a Caspian (Northwestern Iranian) language of Mazandaran province, northern Iran. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**مازرونی**' and '**번역 노트**' (3 bullets in Korean — note Mazandarani is a Caspian language with one of the oldest literary traditions among Iranian languages).\n\n원문:\n${text}`,
  internal_deploy_checklist_ko: (text) =>
    `Write a Korean deployment checklist — a pre/during/post checklist for a production deploy. Use 합쇼체. Markdown: '**한 줄 (배포)**' (1줄 — 무엇을 / 언제), '**배포 전 (체크 bullets)**' (테스트 / 리뷰 / 마이그레이션 / 롤백 준비 / 알림 무음), '**배포 중 (체크 bullets)**' (단계 / 모니터링 지표 / 헬스 확인), '**배포 후 (체크 bullets)**' (스모크 테스트 / 지표 정상 / 알림 복구), '**롤백 트리거 (bullets)**' (이러면 되돌림), '**롤백 절차 (numbered)**', '**커뮤니케이션 (1줄)**' (누구에게 언제), '**담당 (1줄)**'. 각 항목 검증 가능하게.\n\n배포 컨텍스트:\n${text}`,
  sales_proposal_followup_ko: (text) =>
    `Draft a Korean proposal follow-up email — sent after sending a proposal to drive a decision. Use 합쇼체 (정중 + 가치 재확인). Markdown: '**제목**' (1줄), '**본문**' (3-4 단락: 1) 제안 검토 시간 감사 + 핵심 가치 1줄 재강조, 2) 우려/질문 있는지 묻고 답할 준비 됐음, 3) 다음 단계 명확히 — 미팅 제안 / 결정 일정 확인, 4) 가벼운 마무리), '**자주 묻는 점 선제 답변 (bullets)**' (1-2개), '**다음 단계 (1줄)**'. 압박 아닌 도움, 100단어 내외.\n\n제안 컨텍스트:\n${text}`,
  customer_nps_response_plan_ko: (text) =>
    `Write a Korean NPS response plan — turns NPS survey results into segmented follow-up actions. Use 합쇼체. Markdown: '**한 줄 (NPS)**' (1줄 — 점수 + 추세), '**분포 (bullets)**' (프로모터 / 패시브 / 디트랙터 비율), '**핵심 테마 (테이블)**' ('세그먼트 | 주요 코멘트 테마 | 빈도'), '**디트랙터 대응 (bullets)**' (클로즈드 루프 — 누가 언제 연락), '**패시브 → 프로모터 (bullets)**' (전환 기회), '**프로모터 활용 (bullets)**' (레퍼런스 / 리뷰 요청), '**제품/CS 시사점 (bullets)**', '**액션 (테이블)**' ('액션 | 담당 | 시한'). 루프 닫기 강조.\n\nNPS 결과 컨텍스트:\n${text}`,
  pm_survey_design_ko: (text) =>
    `Design a Korean product survey — designs a survey that yields actionable, unbiased data. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄 — 무슨 결정에 쓸 데이터), '**핵심 질문 (bullets)**' (답하고 싶은 것), '**설문 문항 (테이블)**' ('문항 | 유형(척도/단답/객관식) | 측정 의도'), '**편향 방지 (bullets)**' (유도 질문 / 이중 질문 / 순서 효과 피하기), '**길이 / 구성 (1줄)**' (응답 피로 고려), '**대상 / 표본 (1줄)**', '**분석 계획 (1줄)**' (어떻게 해석), '**주의 (1줄)**' (설문의 한계). 짧고 깨끗한 데이터 우선.\n\n설문 컨텍스트:\n${text}`,
  internal_eng_capacity_review_ko: (text) =>
    `Write a Korean engineering capacity review — reviews where engineering time actually went vs. plan. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 계획 대비 실제 + 핵심), '**시간 배분 (테이블)**' ('영역 | 계획% | 실제% | 차이'): 신규 / 유지보수 / 버그 / 인시던트 / 기술부채 / 회의, '**계획 이탈 (bullets)**' (왜 — 인시던트 / 범위확대 등), '**생산성 신호 (bullets)**', '**병목 / 시간 낭비 (bullets)**', '**다음 분기 조정 (테이블)**' ('조정 | 이유'), '**권고 (1줄)**'. 데이터 기반 + 비난 없이.\n\n캐파 데이터 컨텍스트:\n${text}`,
  translate_ko_to_carolinian: (text) =>
    `Translate the Korean text below into natural Carolinian (Refaluwasch) — Micronesian language of Saipan and the Northern Mariana Islands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Refaluwasch**' and '**번역 노트**' (3 bullets in Korean — note Carolinian descends from Chuukic languages carried to the Marianas by migration).\n\n원문:\n${text}`,
  translate_ko_to_satawalese: (text) =>
    `Translate the Korean text below into natural Satawalese — Micronesian language of Satawal atoll, Yap state, Federated States of Micronesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Satawalese**' and '**번역 노트**' (3 bullets in Korean — note Satawalese is a Chuukic language famous from the traditional navigator Mau Piailug).\n\n원문:\n${text}`,
  translate_ko_to_ulithian: (text) =>
    `Translate the Korean text below into natural Ulithian — Micronesian language of Ulithi atoll, Yap state, Federated States of Micronesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ulithian**' and '**번역 노트**' (3 bullets in Korean — note Ulithian is a Chuukic language of the western Caroline Islands).\n\n원문:\n${text}`,
  translate_ko_to_woleaian: (text) =>
    `Translate the Korean text below into natural Woleaian — Micronesian language of Woleai atoll, Yap state, Federated States of Micronesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Woleaian**' and '**번역 노트**' (3 bullets in Korean — note Woleaian has its own syllabary-like script and is a Chuukic language).\n\n원문:\n${text}`,
  translate_ko_to_puluwat: (text) =>
    `Translate the Korean text below into natural Puluwat — Micronesian language of Puluwat atoll, Chuuk state, Federated States of Micronesia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Puluwat**' and '**번역 노트**' (3 bullets in Korean — note Puluwat is a Chuukic language renowned for its traditional star-path navigation).\n\n원문:\n${text}`,
  internal_tech_lead_weekly_ko: (text) =>
    `Write a Korean tech lead weekly update — a tech lead's weekly note to their team and stakeholders. Use 합쇼체. Markdown: '**한 줄 (이번 주)**' (1줄 — 가장 중요한 것), '**기술 진척 (bullets)**' (주요 작업 / 머지 / 결정), '**팀 상태 (1줄)**' (속도 / 분위기 / 블로커), '**리스크 / 기술 우려 (bullets)**', '**의사결정 / 방향 (bullets)**' (정한 것 / 정할 것), '**도움 필요 (bullets)**', '**다음 주 포커스 (bullets)**', '**팀 인정 (1줄)**'. 기술 + 사람 둘 다.\n\n주간 컨텍스트:\n${text}`,
  sales_account_research_brief_ko: (text) =>
    `Write a Korean account research brief — pre-call research on a prospect account. Use 합쇼체. Markdown: '**한 줄 (계정)**' (1줄 — 누구 / 왜 흥미로운), '**회사 개요 (bullets)**' (산업 / 규모 / 최근 뉴스), '**잠재 페인 / 트리거 (bullets)**' (우리가 도울 이벤트 — 채용 / 펀딩 / 출시), '**핵심 인물 (테이블)**' ('이름 | 역할 | 접근 단서'), '**기술 스택 / 현황 추정 (bullets)**', '**진입 가설 (1줄)**' (어떤 각도로), '**대화 포인트 (bullets)**', '**리서치 출처 (1줄)**'. 콜 전에 맥락 무장.\n\n계정 / 컨텍스트:\n${text}`,
  customer_quarterly_planning_ko: (text) =>
    `Write a Korean customer quarterly plan — a CSM's plan for an account for the coming quarter. Use 합쇼체. Markdown: '**한 줄 (분기 목표)**' (1줄), '**계정 상태 (bullets)**' (헬스 / ARR / 갱신 시점), '**고객 분기 목표 (bullets)**' (그들이 추구하는 것), '**우리 분기 목표 (테이블)**' ('목표 | 활동 | 성공 기준'): 채택 / 가치 / 확장 / 리스크, '**핵심 마일스톤 (bullets)**', '**리스크 / 의존성 (bullets)**', '**임원 터치포인트 (1줄)**', '**측정 (bullets)**'. 고객 목표 ↔ 우리 활동 정렬.\n\n계정 컨텍스트:\n${text}`,
  pm_product_strategy_brief_ko: (text) =>
    `Write a Korean product strategy brief — articulates a product's strategy concisely. Use 합쇼체. Markdown: '**한 줄 (전략)**' (1줄 — 어디서 이기려 하는가), '**비전 (1줄)**' (장기 지향점), '**타깃 / 문제 (1단락)**' (누구의 어떤 문제), '**차별화 (bullets)**' (왜 우리가 / 경쟁 대비), '**전략적 베팅 (테이블)**' ('베팅 | 근거 | 성공 신호'), '**의도적 비선택 (bullets)**' (안 할 것), '**핵심 가정 (bullets)**', '**성공 지표 (bullets)**' (노스스타 + 보조). 집중과 트레이드오프 명확히.\n\n전략 컨텍스트:\n${text}`,
  internal_architecture_review_notes_ko: (text) =>
    `Structure Korean architecture review notes — captures decisions and feedback from an architecture review. Use 합쇼체. Markdown: '**한 줄 (리뷰 대상)**' (1줄), '**제안 요지 (1단락)**', '**강점 (bullets)**', '**우려 / 질문 (테이블)**' ('영역 | 우려 | 심각도 | 제안'): 확장성 / 신뢰성 / 보안 / 운영 / 복잡도, '**대안 논의 (bullets)**', '**결정 사항 (bullets)**' (이 자리에서 정한 것), '**남은 액션 (테이블)**' ('액션 | 담당 | 시한'), '**승인 상태 (1줄)**'. 작업에 대한 피드백으로.\n\n아키텍처 리뷰 컨텍스트:\n${text}`,
  translate_ko_to_acholi: (text) =>
    `Translate the Korean text below into natural Acholi (Leb Acoli) — a Luo (Western Nilotic) language of northern Uganda and South Sudan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Leb Acoli**' and '**번역 노트**' (3 bullets in Korean — note Acholi is a Southern Luo language written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_lango: (text) =>
    `Translate the Korean text below into natural Lango — a Luo (Western Nilotic) language of north-central Uganda. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Lango**' and '**번역 노트**' (3 bullets in Korean — note Lango is closely related to Acholi but has Ateso influence).\n\n원문:\n${text}`,
  translate_ko_to_ateso: (text) =>
    `Translate the Korean text below into natural Ateso (Teso) — an Eastern Nilotic language of eastern Uganda and western Kenya. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ateso**' and '**번역 노트**' (3 bullets in Korean — note Ateso is an Eastern Nilotic language of the Teso people, unrelated to the surrounding Bantu languages).\n\n원문:\n${text}`,
  translate_ko_to_karamojong: (text) =>
    `Translate the Korean text below into natural Karamojong (Ŋakarimojoŋ) — an Eastern Nilotic language of northeastern Uganda. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ŋakarimojoŋ**' and '**번역 노트**' (3 bullets in Korean — note Karamojong is closely related to Ateso and Turkana, spoken by pastoralist communities).\n\n원문:\n${text}`,
  translate_ko_to_madi: (text) =>
    `Translate the Korean text below into natural Ma'di — a Central Sudanic language of northwestern Uganda and South Sudan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ma'di**' and '**번역 노트**' (3 bullets in Korean — note Ma'di is a Central Sudanic (Nilo-Saharan) tonal language, distinct from neighbouring Nilotic languages).\n\n원문:\n${text}`,
  internal_release_go_nogo_ko: (text) =>
    `Write a Korean release go/no-go decision doc — drives a clear ship decision at the release gate. Use 합쇼체. Markdown: '**한 줄 (판정)**' (1줄 — GO / NO-GO / 조건부 + 핵심 이유), '**릴리스 (1줄)**' (무엇을 / 언제), '**Go/No-go 기준 (테이블)**' ('기준 | 상태 | 차단 여부 | 코멘트'): 품질 / 운영 준비 / 비즈니스 / 법무, '**미해결 차단 이슈 (bullets)**', '**수용 가능 리스크 (bullets)**' (알고도 넘어가는 것), '**롤백 준비 (1줄)**', '**참석자 / 승인자 (테이블)**' ('역할 | 누구 | 결정'), '**최종 결정 (1줄)**'. 명확한 단일 판정.\n\n릴리스 컨텍스트:\n${text}`,
  sales_handoff_checklist_ko: (text) =>
    `Write a Korean sales-to-CS handoff checklist — ensures nothing is dropped when handing an account to CS. Use 합쇼체. Markdown: '**한 줄 (계정)**' (1줄), '**필수 정보 (체크 bullets)**' (구매 동기 / 성공 기준 / 핵심 연락처 / 약속한 것), '**문서 / 자료 (체크 bullets)**' (계약 / 통화 기록 / 제안서 링크), '**소개 / 인계 (체크 bullets)**' (CS 소개 미팅 / 첫 연락), '**리스크 플래그 (체크 bullets)**' (알아둘 우려), '**첫 30일 액션 (bullets)**', '**핸드오프 미팅 (1줄)**' (Sales+CS 동기화), '**완료 확인 (1줄)**'. 빠짐없는 인계.\n\n핸드오프 컨텍스트:\n${text}`,
  customer_journey_milestone_review_ko: (text) =>
    `Write a Korean customer journey milestone review — reviews progress against key milestones in the customer lifecycle. Use 합쇼체. Markdown: '**한 줄 (단계)**' (1줄 — 지금 라이프사이클 어디 + 건강), '**마일스톤 진척 (테이블)**' ('마일스톤 | 목표 시점 | 상태 | 메모'): 온보딩 / 첫 가치 / 채택 / 확장 / 옹호, '**달성한 것 (bullets)**', '**지연 / 막힌 마일스톤 (bullets)**' (각 '원인 — 액션'), '**다음 마일스톤 (1줄)**' (목표 + 필요), '**리스크 (1줄)**', '**액션 (테이블)**' ('액션 | 담당 | 시한'). 여정 진척 가시화.\n\n여정 컨텍스트:\n${text}`,
  pm_feature_tradeoff_analysis_ko: (text) =>
    `Write a Korean feature tradeoff analysis — analyzes the tradeoffs between options for a feature decision. Use 합쇼체. Markdown: '**한 줄 (결정)**' (1줄 — 무엇을 정하나 + 추천), '**옵션 (테이블)**' ('옵션 | 장점 | 단점 | 노력 | 리스크'), '**평가 기준 (bullets)**' (무엇을 우선 — 사용자 가치 / 속도 / 유지보수), '**기준별 비교 (테이블)**' ('기준 | 옵션A | 옵션B | 옵션C'), '**트레이드오프 핵심 (1단락)**' (무엇을 얻고 무엇을 포기), '**추천 (1단락)**' (어느 옵션 + 왜), '**되돌릴 수 있나 (1줄)**' (가역성). 솔직한 트레이드오프 노출.\n\n결정 컨텍스트:\n${text}`,
  internal_postmortem_learnings_digest_ko: (text) =>
    `Write a Korean postmortem learnings digest — synthesizes themes across multiple postmortems for org-wide learning. Use 합쇼체. Markdown: '**한 줄 (기간/범위)**' (1줄 — 몇 건의 포스트모템 / 어느 기간), '**반복 패턴 (테이블)**' ('패턴 | 빈도 | 대표 사례'): 배포 / 의존성 / 모니터링 / 휴먼 / 용량, '**가장 비싼 원인 (bullets)**' (영향 큰 순), '**잘 작동한 대응 (bullets)**' (반복할 것), '**시스템적 개선 (bullets)**' (개별 fix 아닌 구조적), '**완료된 액션 효과 (1줄)**' (지난 액션이 효과 있었나), '**조직 권고 (bullets)**'. 개별 사고를 넘어 패턴 학습.\n\n포스트모템 모음 컨텍스트:\n${text}`,
  translate_ko_to_warlpiri: (text) =>
    `Translate the Korean text below into natural Warlpiri — a Pama-Nyungan language of the Northern Territory, central Australia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Warlpiri**' and '**번역 노트**' (3 bullets in Korean — note Warlpiri is one of the best-documented Australian Aboriginal languages, with a notable auxiliary register).\n\n원문:\n${text}`,
  translate_ko_to_pitjantjatjara: (text) =>
    `Translate the Korean text below into natural Pitjantjatjara — a Western Desert (Pama-Nyungan) language of central Australia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Pitjantjatjara**' and '**번역 노트**' (3 bullets in Korean — note Pitjantjatjara is a Western Desert dialect written in Latin script with an underline diacritic for retroflex sounds).\n\n원문:\n${text}`,
  translate_ko_to_yolngu: (text) =>
    `Translate the Korean text below into natural Yolŋu Matha (Djambarrpuyngu) — a Pama-Nyungan language of Arnhem Land, northern Australia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Yolŋu Matha**' and '**번역 노트**' (3 bullets in Korean — note Yolŋu Matha is a cluster of clan varieties; Djambarrpuyngu is a widely-used lingua franca among them).\n\n원문:\n${text}`,
  translate_ko_to_arrernte: (text) =>
    `Translate the Korean text below into natural Arrernte — a Pama-Nyungan language of the Alice Springs region, central Australia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Arrernte**' and '**번역 노트**' (3 bullets in Korean — note Arrernte has a large consonant inventory and is written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_tiwi: (text) =>
    `Translate the Korean text below into natural Tiwi — a language isolate of the Tiwi Islands off northern Australia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tiwi**' and '**번역 노트**' (3 bullets in Korean — note Tiwi is a non-Pama-Nyungan language isolate; traditional Tiwi is highly polysynthetic).\n\n원문:\n${text}`,
  internal_oncall_summary_weekly_ko: (text) =>
    `Write a Korean weekly on-call summary — a short weekly digest of on-call activity for the team. Use 합쇼체. Markdown: '**한 줄 (이번 주)**' (1줄 — 부담 정도 + 핵심 사건), '**페이지 통계 (1줄)**' (총 / 야간 / 오탐%), '**주요 사건 (테이블)**' ('사건 | 심각도 | 대응 | 후속'), '**반복 / 주의 신호 (bullets)**', '**알림 튜닝 (bullets)**' (조정/삭제한 것), '**열린 후속 액션 (bullets)**', '**다음 온콜에게 (1줄)**'. 간결 + toil 가시화.\n\n온콜 주간 컨텍스트:\n${text}`,
  sales_upsell_pitch_ko: (text) =>
    `Write a Korean upsell pitch — a concise pitch to upgrade an existing customer to a higher tier or add-on. Use 합쇼체. Markdown: '**한 줄 (제안)**' (1줄 — 무엇으로 업그레이드 / 왜 그들에게), '**현재 한계 (bullets)**' (지금 플랜에서 막히는 것 — 사용 데이터 근거), '**업그레이드 가치 (bullets)**' (각 '기능/한도 — 그들에게 의미'), '**ROI (1줄)**', '**가격 차이 (1줄)**' (투명하게), '**증거 / 유사 사례 (1줄)**', '**다음 단계 (1줄)**'. 한계 → 가치 → 자연스러운 업그레이드. 압박 금지.\n\n업셀 컨텍스트:\n${text}`,
  customer_qbr_action_plan_ko: (text) =>
    `Write a Korean QBR action plan — the agreed action plan coming out of a customer QBR. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 다음 분기 함께 추구할 것), '**합의 우선순위 (bullets)**' (QBR에서 정한 것), '**액션 아이템 (테이블)**' ('액션 | 담당(우리/고객) | 시한 | 성공 기준'), '**의존성 (bullets)**' (서로 필요한 것), '**리스크 (1줄)**', '**다음 체크인 (1줄)**', '**임원 후원 필요 (1줄)**' (있으면). 양측이 공유·실행 가능하게.\n\nQBR 컨텍스트:\n${text}`,
  pm_impact_effort_matrix_ko: (text) =>
    `Produce a Korean impact/effort prioritization matrix — sorts initiatives into a 2x2 of impact vs. effort. Use 합쇼체. Markdown: '**한 줄 (추천)**' (1줄 — 무엇부터), '**사분면 (bullets per quadrant)**': '**Quick Wins (고임팩트·저노력)**', '**Big Bets (고임팩트·고노력)**', '**Fill-ins (저임팩트·저노력)**', '**Time Sinks (저임팩트·고노력 — 피할 것)**', '**평가 근거 (테이블)**' ('항목 | 임팩트(상/중/하) | 노력(상/중/하) | 사분면'), '**권고 순서 (numbered)**', '**주의 (1줄)**' (추정의 불확실성). Quick Wins 먼저, Time Sinks 회피.\n\n이니셔티브 목록:\n${text}`,
  internal_team_skills_matrix_ko: (text) =>
    `Build a Korean team skills matrix — maps team members' skills to find gaps and growth paths. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**스킬 매트릭스 (테이블)**' ('스킬 | 멤버1 | 멤버2 | ... (수준 0-3)'), '**커버리지 분석 (bullets)**' (단일 의존(bus factor) / 공백 스킬), '**강점 영역 (bullets)**', '**리스크 (bullets)**' (한 명만 아는 핵심 영역), '**성장 매칭 (테이블)**' ('멤버 | 키우고 싶은 스킬 | 멘토/기회'), '**채용/교육 시사점 (bullets)**', '**다음 액션 (1줄)**'. 공백과 성장 둘 다.\n\n팀 / 스킬 컨텍스트:\n${text}`,
  translate_ko_to_kodava: (text) =>
    `Translate the Korean text below into natural Kodava (Kodava takk) — a Dravidian language of the Kodagu (Coorg) region, Karnataka, India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kodava takk**' and '**번역 노트**' (3 bullets in Korean — note Kodava is a Dravidian language usually written in the Kannada script).\n\n원문:\n${text}`,
  translate_ko_to_badaga: (text) =>
    `Translate the Korean text below into natural Badaga — a Dravidian language of the Nilgiri Hills, Tamil Nadu, India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Badaga**' and '**번역 노트**' (3 bullets in Korean — note Badaga is a South Dravidian language closely related to Kannada).\n\n원문:\n${text}`,
  translate_ko_to_gondi: (text) =>
    `Translate the Korean text below into natural Gondi — a Dravidian language of central India (Madhya Pradesh, Maharashtra, Telangana). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Gondi**' and '**번역 노트**' (3 bullets in Korean — note Gondi is a Central Dravidian language of the Gond people, with its own Gunjala Gondi script).\n\n원문:\n${text}`,
  translate_ko_to_kui: (text) =>
    `Translate the Korean text below into natural Kui — a Dravidian language of Odisha, eastern India. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kui**' and '**번역 노트**' (3 bullets in Korean — note Kui is a Central Dravidian language of the Kondh people, usually written in the Odia script).\n\n원문:\n${text}`,
  translate_ko_to_brahui: (text) =>
    `Translate the Korean text below into natural Brahui — a Dravidian language of Balochistan, Pakistan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Brahui**' and '**번역 노트**' (3 bullets in Korean — note Brahui is remarkable as a Dravidian language isolated far northwest of the others, written in a Perso-Arabic script).\n\n원문:\n${text}`,
  internal_data_pipeline_design_ko: (text) =>
    `Write a Korean data pipeline design doc — designs an ETL/data pipeline for review. Use 합쇼체. Markdown: '**한 줄 (파이프라인)**' (1줄 — 무엇을 / 왜), '**소스 → 싱크 (1줄)**' (어디서 어디로), '**데이터 흐름 (numbered)**' (추출 → 변환 → 적재 각 단계), '**스키마 / 계약 (bullets)**' (입력/출력 형태), '**스케줄 / 트리거 (1줄)**' (배치/스트리밍 + 빈도), '**데이터 품질 (bullets)**' (검증 / 결측 / 중복 처리), '**장애 처리 (bullets)**' (재시도 / 멱등성 / 백필), '**모니터링 (bullets)**' (지연 / 볼륨 / 신선도), '**비용 / 확장 (1줄)**'. 신뢰성 + 멱등성 강조.\n\n파이프라인 컨텍스트:\n${text}`,
  sales_renewal_kickoff_ko: (text) =>
    `Write a Korean renewal kickoff plan — kicks off the renewal motion well ahead of the date. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 갱신일 + 목표), '**계정 상태 점검 (bullets)**' (헬스 / 챔피언 / 사용), '**갱신 팀 (테이블)**' ('역할 | 누구'), '**가치 스토리 준비 (bullets)**' (어떤 데이터로), '**리스크 사전 평가 (bullets)**', '**타임라인 (테이블)**' ('시점 | 활동 | 담당'), '**확장 가능성 (1줄)**', '**첫 액션 (bullets)**'. 조기 시작 + 선제.\n\n갱신 컨텍스트:\n${text}`,
  customer_onboarding_kickoff_email_ko: (text) =>
    `Draft a Korean onboarding kickoff email — the first warm email to a new customer to start onboarding. Use 합쇼체 (따뜻 + 명확). Markdown: '**제목**' (1줄), '**본문**' (4 단락: 1) 환영 + 함께하게 되어 기쁨 + 1줄, 2) 우리가 함께 이룰 것 — 성공 그림 1-2줄, 3) 첫 단계 명확히 — 킥오프 미팅 제안(날짜 옵션) + 준비물, 4) 담당자 소개 + 언제든 연락), '**첫 30일 미리보기 (bullets)**' (3단계), '**다음 액션 (1줄)**'. 안심 + 추진력.\n\n온보딩 컨텍스트:\n${text}`,
  pm_quarterly_roadmap_review_ko: (text) =>
    `Write a Korean quarterly roadmap review — reviews roadmap progress and adjusts for the next quarter. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄), '**계획 대비 출시 (테이블)**' ('계획 항목 | 상태 | 비고'), '**이동/취소된 것 (bullets)**' (왜 — 우선순위 변화), '**배운 것 (bullets)**' (가정 검증 결과), '**다음 분기 조정 (테이블)**' ('테마 | 변화 | 이유'), '**Now/Next/Later 업데이트 (bullets)**', '**리스크 / 의존성 (bullets)**', '**이해관계자 메시지 (1줄)**'. 방향과 근거 중심.\n\n로드맵 컨텍스트:\n${text}`,
  internal_incident_severity_guide_ko: (text) =>
    `Write a Korean incident severity guide — defines severity levels so responders classify incidents consistently. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**심각도 정의 (테이블)**' ('레벨(SEV1-4) | 정의 | 예시 | 대응 기대 | 누가 관여'), '**판단 기준 (bullets)**' (영향 범위 / 데이터 / 매출 / 평판), '**에스컬레이션 매핑 (1줄)**' (레벨 → 누구), '**커뮤니케이션 요구 (테이블)**' ('레벨 | 내부 | 외부 | 빈도'), '**상향/하향 조정 (1줄)**' (진행 중 재분류), '**예시 시나리오 (bullets)**'. 일관성 + 빠른 판단.\n\n심각도 컨텍스트:\n${text}`,
  translate_ko_to_makonde: (text) =>
    `Translate the Korean text below into natural Makonde — a Bantu language of the Mozambique-Tanzania border plateau. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Makonde**' and '**번역 노트**' (3 bullets in Korean — note Makonde people are known for their sculpture; the language is written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_chiyao: (text) =>
    `Translate the Korean text below into natural Yao (Chiyao) — a Bantu language of Malawi, Mozambique and Tanzania. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Chiyao**' and '**번역 노트**' (3 bullets in Korean — note this Yao is the African Bantu language, unrelated to the Yao of Southeast Asia).\n\n원문:\n${text}`,
  translate_ko_to_makhuwa: (text) =>
    `Translate the Korean text below into natural Makhuwa (Emakhuwa) — the most widely spoken Bantu language of northern Mozambique. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Emakhuwa**' and '**번역 노트**' (3 bullets in Korean — note Makhuwa is the largest indigenous language of Mozambique).\n\n원문:\n${text}`,
  translate_ko_to_tumbuka: (text) =>
    `Translate the Korean text below into natural Tumbuka (Chitumbuka) — a Bantu language of northern Malawi and eastern Zambia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Chitumbuka**' and '**번역 노트**' (3 bullets in Korean — note Tumbuka is a major language of northern Malawi, written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_nyakyusa: (text) =>
    `Translate the Korean text below into natural Nyakyusa — a Bantu language of the Mbeya region, southwestern Tanzania, and northern Malawi. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Nyakyusa**' and '**번역 노트**' (3 bullets in Korean — note Nyakyusa is spoken around the northern tip of Lake Malawi).\n\n원문:\n${text}`,
  internal_api_design_review_ko: (text) =>
    `Write a Korean API design review — reviews a proposed API for usability, consistency and longevity. Use 합쇼체. Markdown: '**한 줄 (API)**' (1줄 — 무엇을 노출), '**리소스 / 엔드포인트 (테이블)**' ('메서드 | 경로 | 목적'), '**일관성 점검 (bullets)**' (네이밍 / 페이지네이션 / 에러 형식 / 버저닝), '**사용성 (bullets)**' (직관성 / 흔한 케이스 쉬운가), '**호환성 / 진화 (bullets)**' (깨지는 변경 / 확장 여지), '**보안 / 권한 (bullets)**', '**우려 + 제안 (테이블)**' ('이슈 | 심각도 | 제안'), '**판정 (1줄)**'. 장기적 일관성 강조.\n\nAPI 컨텍스트:\n${text}`,
  sales_weekly_forecast_ko: (text) =>
    `Write a Korean weekly sales forecast — a rep/manager's weekly forecast update. Use 합쇼체. Markdown: '**한 줄 (예측)**' (1줄 — commit / best case / 목표 대비), '**카테고리 (테이블)**' ('카테고리 | 금액 | 딜 수'): Commit / Best Case / Pipeline, '**이번 주 변화 (bullets)**' (들어온 것 / 슬립된 것 / 닫힌 것), '**리스크 딜 (bullets)**' (각 '딜 — 리스크 — 액션'), '**커버리지 (1줄)**' (파이프라인 배수), '**필요 지원 (bullets)**', '**이번 주 우선순위 (bullets)**'. 정확 + 액션 중심.\n\n예측 컨텍스트:\n${text}`,
  customer_success_metrics_review_ko: (text) =>
    `Write a Korean customer success metrics review — reviews CS portfolio health metrics. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 포트폴리오 건강 + 핵심), '**핵심 지표 (테이블)**' ('지표 | 현재 | 추세 | 목표'): NRR / GRR / 헬스 분포 / 채택률 / NPS, '**잘 되는 것 (bullets)**', '**우려 (bullets)**' (각 '지표 — 원인 — 액션'), '**세그먼트 차이 (bullets)**', '**리스크 계정 (1줄)**' (집중 필요), '**개선 액션 (테이블)**' ('액션 | 담당 | 시한'), '**한 줄 전망 (1줄)**'. 데이터 → 액션.\n\nCS 지표 컨텍스트:\n${text}`,
  pm_feature_request_triage_ko: (text) =>
    `Write a Korean feature request triage — sorts incoming feature requests into a decision. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 이번 배치 핵심 패턴), '**요청 분류 (테이블)**' ('요청 | 빈도 | 요청자 유형 | 근본 니즈(JTBD) | 판정'): 수용 / 백로그 / 보류 / 거절, '**테마 (bullets)**' (요청 뒤 공통 니즈), '**빠른 승리 (bullets)**' (저비용 고가치), '**전략 부합 안 함 (bullets)**' (거절 + 이유), '**요청자 회신 가이드 (1줄)**' (루프 닫기), '**다음 액션 (테이블)**'. 요청이 아닌 니즈에 집중.\n\n요청 목록:\n${text}`,
  internal_allhands_notes_ko: (text) =>
    `Structure Korean all-hands meeting notes — captures key points and decisions from a company/team all-hands. Use 합쇼체. Markdown: '**한 줄 (올핸즈)**' (1줄 — 핵심 메시지), '**주요 업데이트 (bullets)**' (회사/팀 — 주제별), '**성과 / 인정 (bullets)**', '**전략 / 우선순위 (bullets)**' (강조된 방향), '**Q&A 하이라이트 (테이블)**' ('질문 | 답변 핵심'), '**액션 / 변화 (bullets)**' (모두에게 영향), '**팔로업 (bullets)**' (추가 정보 약속), '**한 줄 정리 (1줄)**'. 못 들은 사람도 따라잡게.\n\n올핸즈 컨텍스트:\n${text}`,
  translate_ko_to_kituba: (text) =>
    `Translate the Korean text below into natural Kituba (Kikongo ya leta) — a Kongo-based creole and lingua franca of the Republic of the Congo and DR Congo. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kituba**' and '**번역 노트**' (3 bullets in Korean — note Kituba is a simplified Kongo-based contact language, a national language in both Congos).\n\n원문:\n${text}`,
  translate_ko_to_fang: (text) =>
    `Translate the Korean text below into natural Fang — a Bantu language of Equatorial Guinea, Gabon and southern Cameroon. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Fang**' and '**번역 노트**' (3 bullets in Korean — note Fang is a major language of Gabon and Equatorial Guinea, written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_teke: (text) =>
    `Translate the Korean text below into natural Teke (Kiteke) — a Bantu language cluster of the Republic of the Congo, DR Congo and Gabon. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kiteke**' and '**번역 노트**' (3 bullets in Korean — note Teke is spoken on the Téké/Bateke plateau north of the Congo River).\n\n원문:\n${text}`,
  translate_ko_to_punu: (text) =>
    `Translate the Korean text below into natural Punu (Yipunu) — a Bantu language of southern Gabon and the Republic of the Congo. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Yipunu**' and '**번역 노트**' (3 bullets in Korean — note Punu people are known for their white-faced okuyi masks; the language is Bantu).\n\n원문:\n${text}`,
  translate_ko_to_duala: (text) =>
    `Translate the Korean text below into natural Duala — a Bantu language of the coastal Littoral region of Cameroon. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Duala**' and '**번역 노트**' (3 bullets in Korean — note Duala was an important early lingua franca and mission language of coastal Cameroon).\n\n원문:\n${text}`,
  internal_load_testing_plan_ko: (text) =>
    `Write a Korean load testing plan — plans a load/performance test for a system. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 무엇을 / 왜 검증), '**대상 / 범위 (bullets)**' (어떤 경로 / 컴포넌트), '**부하 시나리오 (테이블)**' ('시나리오 | 부하 패턴 | 동시성/RPS | 기간'): 평상 / 피크 / 스파이크 / 내구, '**성공 기준 (테이블)**' ('지표 | 목표'): p50/p95/p99 지연 / 오류율 / 처리량, '**환경 / 데이터 (bullets)**' (프로덕션 유사성), '**모니터링 (bullets)**', '**중단 기준 (1줄)**' (이러면 멈춤), '**분석 / 후속 (1줄)**'. 현실적 시나리오 강조.\n\n부하 테스트 컨텍스트:\n${text}`,
  sales_intro_email_ko: (text) =>
    `Draft a Korean sales intro email — a warm, relevant first-touch email to a prospect. Use 합쇼체 (정중 + 간결, 스팸 같지 않게). Markdown: '**제목**' (1줄, 호기심 + 관련성), '**본문**' (4-5줄: 1) 개인화 1줄 — 그들에 대한 진짜 관찰, 2) 가치 가설 1-2줄 — 우리가 어떻게 도울 수 있을지, 3) 사회적 증거 1줄(선택), 4) 가벼운 CTA — 짧은 대화 제안), '**대안 제목 2개 (bullets)**', '**팁 (1줄)**' (개인화/타이밍). 80단어 이내, 나에 대한 얘기 최소.\n\n프로스펙트 컨텍스트:\n${text}`,
  customer_qbr_invite_email_ko: (text) =>
    `Draft a Korean QBR invitation email — invites a customer to a quarterly business review. Use 합쇼체 (따뜻 + 가치 중심). Markdown: '**제목**' (1줄), '**본문**' (3-4 단락: 1) 인사 + QBR 제안 + 왜 가치 있는지 1줄, 2) 다룰 내용 미리보기 — 성과 회고 / 로드맵 / 다음 계획, 3) 일정 옵션 + 소요 시간 + 누가 참석하면 좋을지, 4) 준비 사항 / 기대), '**아젠다 미리보기 (bullets)**', '**다음 단계 (1줄)**'. 회의가 아닌 가치로 프레이밍.\n\nQBR 컨텍스트:\n${text}`,
  pm_opportunity_solution_tree_ko: (text) =>
    `Build a Korean opportunity solution tree — maps an outcome to opportunities to solutions (Teresa Torres style). Use 합쇼체. Markdown: '**목표 결과 (1줄)**' (측정 가능한 outcome), '**기회 (테이블)**' ('기회(고객 니즈/페인) | 근거 | 임팩트 추정'), '**기회별 솔루션 (bullets)**' (각 기회 아래 2-3개 솔루션 아이디어), '**우선 기회 (1줄)**' (먼저 공략할 것 + 이유), '**우선 솔루션 / 실험 (bullets)**' (가장 먼저 검증할 것), '**가정 / 리스크 (bullets)**', '**다음 액션 (1줄)**'. 솔루션이 아닌 기회에서 출발.\n\n결과 / 컨텍스트:\n${text}`,
  internal_retro_facilitation_guide_ko: (text) =>
    `Write a Korean retrospective facilitation guide — helps someone run an effective, psychologically-safe retro. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**사전 준비 (bullets)**' (데이터 / 안전 분위기 / 형식 선택), '**진행 흐름 (테이블)**' ('단계 | 활동 | 시간'): 분위기 열기 → 데이터 모으기 → 인사이트 → 액션 → 마무리, '**포맷 옵션 (bullets)**' (Start/Stop/Continue / Mad-Sad-Glad / 4Ls 등), '**심리적 안전 (bullets)**' (비난 금지 / 모두 발언 / 프라임 디렉티브), '**액션 만들기 (bullets)**' (적게 + 구체 + 담당), '**안티패턴 (1줄)**' (불평만 / 액션 없음). 안전 + 행동.\n\n회고 컨텍스트:\n${text}`,
  translate_ko_to_lue: (text) =>
    `Translate the Korean text below into natural Tai Lü (Tai Lue) — a Southwestern Tai language of Sipsongpanna (Xishuangbanna), Yunnan, and northern Laos/Thailand. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tai Lü**' and '**번역 노트**' (3 bullets in Korean — note Tai Lü has its own New Tai Lue script).\n\n원문:\n${text}`,
  translate_ko_to_tai_dam: (text) =>
    `Translate the Korean text below into natural Tai Dam (Black Tai) — a Southwestern Tai language of northwestern Vietnam and Laos. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tai Dam**' and '**번역 노트**' (3 bullets in Korean — note Tai Dam has its own Tai Viet script and is spoken by diaspora communities worldwide).\n\n원문:\n${text}`,
  translate_ko_to_nung: (text) =>
    `Translate the Korean text below into natural Nùng — a Central Tai language of northeastern Vietnam and Guangxi, China. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Nùng**' and '**번역 노트**' (3 bullets in Korean — note Nùng is closely related to Tày and Zhuang, written in a Latin-based orthography).\n\n원문:\n${text}`,
  translate_ko_to_tay: (text) =>
    `Translate the Korean text below into natural Tày — a Central Tai language of northern Vietnam. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Tày**' and '**번역 노트**' (3 bullets in Korean — note Tày is one of the largest minority languages of Vietnam, closely related to Nùng).\n\n원문:\n${text}`,
  translate_ko_to_bouyei: (text) =>
    `Translate the Korean text below into natural Bouyei (Buyi) — a Northern Tai language of Guizhou province, southern China. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Bouyei**' and '**번역 노트**' (3 bullets in Korean — note Bouyei is a Northern Tai language closely related to Zhuang, written in a Latin-based orthography).\n\n원문:\n${text}`,
  internal_eng_quarterly_goals_ko: (text) =>
    `Write Korean engineering quarterly goals — sets an eng team's technical goals for the quarter. Use 합쇼체. Markdown: '**한 줄 (분기 테마)**' (1줄), '**제품 지원 목표 (bullets)**' (제품 로드맵 받치는 것), '**기술 건강 목표 (테이블)**' ('목표 | 측정 | 현재 | 목표값'): 신뢰성 / 성능 / 기술부채 / 개발자경험, '**투자 배분 (1줄)**' (신규 vs 건강 vs 유지), '**의도적 비선택 (bullets)**', '**리스크 / 의존성 (bullets)**', '**측정 / 체크인 (1줄)**'. 제품 ↔ 기술 건강 균형.\n\n분기 컨텍스트:\n${text}`,
  sales_deal_desk_review_ko: (text) =>
    `Write a Korean deal desk review — reviews a non-standard deal for approval (pricing/terms exceptions). Use 합쇼체. Markdown: '**한 줄 (요청)**' (1줄 — 무슨 예외 / 승인 필요), '**딜 요약 (bullets)**' (고객 / 규모 / 전략 가치), '**요청 예외 (테이블)**' ('항목 | 표준 | 요청 | 사유'), '**재무 영향 (bullets)**' (할인율 / 마진 / 선례 리스크), '**전략적 정당화 (1단락)**' (왜 가치 있나), '**리스크 (bullets)**' (선례 / 형평성), '**대안 (1줄)**', '**권고 (1줄)**' (승인/조건부/반려 + 이유). 데이터 기반 판단.\n\n딜 컨텍스트:\n${text}`,
  customer_executive_email_ko: (text) =>
    `Draft a Korean executive-to-executive email — a concise, high-level email from our exec to the customer's exec. Use 합쇼체 (간결 + 격조 + 진심). Markdown: '**제목**' (1줄), '**본문**' (3 단락: 1) 따뜻한 인사 + 관계/맥락 1줄, 2) 핵심 메시지 — 가치 인정 / 전략 제안 / 요청 중 하나에 집중, 3) 명확한 다음 단계 + 직접 연락 의향), '**한 줄 (의도)**' (이 메일의 목적). 짧게 (150단어 이내), C레벨 톤 — 디테일은 팀에 위임.\n\n임원 메일 컨텍스트:\n${text}`,
  pm_changelog_entry_ko: (text) =>
    `Write a Korean changelog entry — a crisp, user-facing changelog item for a release. Use 해요체 (명확 + 친근). Markdown: '**제목 (1줄)**' (무엇이 바뀌었는지 — 사용자 관점), '**카테고리 (1줄)**' (✨ 새기능 / ⚡ 개선 / 🐛 버그수정), '**설명 (2-3줄)**' (무엇을 / 사용자에게 어떤 이점 — 내부 용어 금지), '**사용 방법 (1줄)**' (어디서 / 어떻게 — 필요하면), '**참고 (1줄)**' (마이그레이션 / 주의 — 있으면). 짧고 가치 중심.\n\n변경 컨텍스트:\n${text}`,
  internal_code_review_guidelines_ko: (text) =>
    `Write Korean code review guidelines — sets norms for giving and receiving code reviews. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**리뷰어 원칙 (bullets)**' (작업을 리뷰 / 질문으로 / 차단 vs 제안 명시 / 빨리), '**작성자 원칙 (bullets)**' (작은 PR / 맥락 제공 / 방어 금지), '**무엇을 볼까 (bullets)**' (정확성 / 가독성 / 테스트 / 보안 — 스타일은 도구에 위임), '**리뷰 SLA (1줄)**' (응답 시간), '**톤 (bullets)**' (예시 — 좋은 코멘트 vs 나쁜 코멘트), '**머지 기준 (1줄)**'. 빠르고 친절하게.\n\n코드 리뷰 컨텍스트:\n${text}`,
  translate_ko_to_dagur: (text) =>
    `Translate the Korean text below into natural Daur (Dagur) — a Mongolic language of Inner Mongolia and Heilongjiang, China. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Daur**' and '**번역 노트**' (3 bullets in Korean — note Daur is a Mongolic language with heavy Manchu and Chinese influence, usually written in a Latin or Pinyin-based system).\n\n원문:\n${text}`,
  translate_ko_to_evenki: (text) =>
    `Translate the Korean text below into natural Evenki — a Northern Tungusic language of Siberia and northern China. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Evenki**' and '**번역 노트**' (3 bullets in Korean — note Evenki is a Tungusic language of reindeer-herding peoples, written in Cyrillic in Russia).\n\n원문:\n${text}`,
  translate_ko_to_even: (text) =>
    `Translate the Korean text below into natural Even (Lamut) — a Northern Tungusic language of northeastern Siberia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Even**' and '**번역 노트**' (3 bullets in Korean — note Even is closely related to Evenki, written in Cyrillic).\n\n원문:\n${text}`,
  translate_ko_to_nanai: (text) =>
    `Translate the Korean text below into natural Nanai (Hezhen) — a Southern Tungusic language of the Amur River basin, Russia and China. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Nanai**' and '**번역 노트**' (3 bullets in Korean — note Nanai is a Tungusic language of the Amur, written in Cyrillic in Russia).\n\n원문:\n${text}`,
  translate_ko_to_manchu: (text) =>
    `Translate the Korean text below into natural Manchu (ᠮᠠᠨᠵᡠ) — a Tungusic language of northeastern China, language of the Qing dynasty court. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Manju**' (Manchu script with Möllendorff romanization where helpful) and '**번역 노트**' (3 bullets in Korean — note Manchu uses a vertical alphabet derived from Mongolian and is now critically endangered).\n\n원문:\n${text}`,
  internal_release_train_plan_ko: (text) =>
    `Write a Korean release train plan — sets up a regular, predictable release cadence (release train). Use 합쇼체. Markdown: '**한 줄 (릴리스 트레인)**' (1줄 — 주기 + 원칙), '**케이던스 (1줄)**' (얼마나 자주 — 주간/격주), '**고정 일정 (테이블)**' ('단계 | 시점(D-X) | 활동'): 코드프리즈 / 스테이징 / QA / 릴리스, '**탑승 규칙 (bullets)**' ('준비된 것만 탑승, 늦으면 다음 차'), '**예외 / 핫픽스 (1줄)**', '**역할 (테이블)**' ('역할 | 책임'), '**품질 게이트 (bullets)**', '**측정 (bullets)**' (예측성 / 빈도). 예측 가능성 강조.\n\n릴리스 트레인 컨텍스트:\n${text}`,
  sales_competitive_displacement_ko: (text) =>
    `Write a Korean competitive displacement plan — a plan to win a customer away from an incumbent competitor. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 누구를 대체 / 핵심 각도), '**현 솔루션 (bullets)**' (그들이 쓰는 것 + 불만), '**전환 장벽 (bullets)**' (왜 안 바꾸나 — 비용/리스크/관성), '**우리 우위 (테이블)**' ('영역 | 우리 | 그들'), '**전환 가치 (1줄)**' (바꿀 만한 이유), '**리스크 완화 (bullets)**' (마이그레이션/병행), '**증거 (1줄)**' (유사 전환 사례), '**전략 (numbered)**' (단계적 접근). 전환 비용 정면 돌파.\n\n경쟁 전환 컨텍스트:\n${text}`,
  customer_quarterly_check_in_email_ko: (text) =>
    `Draft a Korean quarterly check-in email — a light-touch quarterly email to a customer. Use 합쇼체 (따뜻 + 간결). Markdown: '**제목**' (1줄), '**본문**' (3 단락: 1) 안부 + 지난 분기 함께한 것 1줄, 2) 가치 신호 / 성과 1줄 + 도움 될 만한 팁이나 신규 기능 1개, 3) 가벼운 제안 — 짧은 통화 / QBR / 질문 받기), '**유용한 링크 (bullets)**' (1-2개), '**다음 단계 (1줄)**'. 영업 아닌 관계 톤, 100단어 내외.\n\n체크인 컨텍스트:\n${text}`,
  pm_release_scope_decision_ko: (text) =>
    `Write a Korean release scope decision doc — decides what makes the cut for a release under time pressure. Use 합쇼체. Markdown: '**한 줄 (결정)**' (1줄 — 무엇을 넣고 뺄지), '**제약 (1줄)**' (날짜 / 리소스 고정), '**후보 항목 (테이블)**' ('항목 | 가치 | 노력 | 리스크 | 판정(IN/OUT/STRETCH)'), '**반드시 포함 (bullets)**' (이유), '**제외 (bullets)**' (다음으로 — 이유), '**스트레치 (bullets)**' (시간 남으면), '**트레이드오프 (1단락)**' (무엇을 포기), '**커뮤니케이션 (1줄)**' (이해관계자에게). 날짜 사수 vs 범위 명확히.\n\n범위 결정 컨텍스트:\n${text}`,
  internal_engineering_glossary_ko: (text) =>
    `Write a Korean engineering glossary — defines team/domain-specific terms so everyone shares vocabulary. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**용어 (테이블)**' ('용어 | 정의 | 예시/맥락 | 혼동 주의'), '**도메인 약어 (bullets)**' (자주 쓰는 약어 풀이), '**내부 코드네임 (bullets)**' (프로젝트/시스템 별칭 → 실제), '**쓰지 말 것 (bullets)**' (모호/중복 용어 + 대체어), '**유지 관리 (1줄)**' (누가 / 언제 갱신). 신규 입사자가 빨리 따라잡게.\n\n용어 컨텍스트:\n${text}`,
  translate_ko_to_kiche: (text) =>
    `Translate the Korean text below into natural K'iche' (Quiché) — a Mayan language of the Guatemalan highlands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**K'iche'**' and '**번역 노트**' (3 bullets in Korean — note K'iche' is the most widely spoken Mayan language of Guatemala, the language of the Popol Vuh).\n\n원문:\n${text}`,
  translate_ko_to_qeqchi: (text) =>
    `Translate the Korean text below into natural Q'eqchi' — a Mayan language of central Guatemala and Belize. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Q'eqchi'**' and '**번역 노트**' (3 bullets in Korean — note Q'eqchi' is one of the fastest-growing Mayan languages, written in Latin script with apostrophes for ejectives).\n\n원문:\n${text}`,
  translate_ko_to_mam: (text) =>
    `Translate the Korean text below into natural Mam — a Mayan language of the western Guatemalan highlands and Chiapas, Mexico. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Mam**' and '**번역 노트**' (3 bullets in Korean — note Mam is a major Mayan language with a complex consonant system).\n\n원문:\n${text}`,
  translate_ko_to_kaqchikel: (text) =>
    `Translate the Korean text below into natural Kaqchikel — a Mayan language of the central Guatemalan highlands. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kaqchikel**' and '**번역 노트**' (3 bullets in Korean — note Kaqchikel is closely related to K'iche' and Tz'utujil around Lake Atitlán).\n\n원문:\n${text}`,
  translate_ko_to_tzotzil: (text) =>
    `Translate the Korean text below into natural Tzotzil (Bats'i k'op) — a Mayan language of the Chiapas highlands, Mexico. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Bats'i k'op**' and '**번역 노트**' (3 bullets in Korean — note Tzotzil is a Mayan language of highland Chiapas, closely related to Tzeltal).\n\n원문:\n${text}`,
  internal_eng_roadmap_ko: (text) =>
    `Write a Korean engineering roadmap — a forward-looking plan of technical investments (not features). Use 합쇼체. Markdown: '**한 줄 (방향)**' (1줄 — 기술적으로 어디로), '**왜 (1단락)**' (제품 전략 / 스케일 / 부채), '**테마 (테이블)**' ('테마 | 왜 | 대표 작업 | 기간(Now/Next/Later)'): 신뢰성 / 확장성 / 개발자경험 / 보안, '**Now (bullets)**', '**Next (bullets)**', '**Later (bullets)**', '**의존성 / 리스크 (bullets)**', '**성공 모습 (1줄)**'. 기능이 아닌 기반 투자 중심.\n\n기술 로드맵 컨텍스트:\n${text}`,
  sales_quarterly_review_internal_ko: (text) =>
    `Write a Korean internal quarterly sales review — a team's internal QBR of its own sales performance. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 목표 달성 + 핵심), '**성과 (테이블)**' ('지표 | 목표 | 실제 | 달성도'): 매출 / 신규 / 갱신 / 파이프라인, '**잘된 것 (bullets)**' (반복할 패턴), '**아쉬운 것 (bullets)**' (원인 분석), '**승패 패턴 (bullets)**' (왜 이기고 지나), '**다음 분기 우선순위 (bullets)**', '**필요 지원 / 리소스 (bullets)**', '**예측 (1줄)**'. 솔직 + 학습 중심.\n\n분기 영업 컨텍스트:\n${text}`,
  customer_stakeholder_map_ko: (text) =>
    `Build a Korean customer stakeholder map — maps the people in an account to manage the relationship. Use 합쇼체. Markdown: '**한 줄 (계정)**' (1줄), '**스테이크홀더 (테이블)**' ('이름 | 역할 | 영향력(상/중/하) | 우리에 대한 태도(지지/중립/회의) | 관계 강도'), '**챔피언 (bullets)**' (누가 / 얼마나 견고), '**리스크 인물 (bullets)**' (블로커 / 이탈 시 위험), '**커버리지 갭 (bullets)**' (관계 없는 핵심 인물), '**관계 강화 액션 (테이블)**' ('대상 | 액션 | 담당'), '**멀티스레딩 전략 (1줄)**'. 단일 의존 리스크 가시화.\n\n계정 / 인물 컨텍스트:\n${text}`,
  pm_feature_sunset_comms_ko: (text) =>
    `Write Korean feature sunset communications — messages to users about retiring a feature. Use 합쇼체 (투명 + 배려). Markdown: '**한 줄 (안내)**' (1줄 — 무엇이 / 언제 종료), '**사용자 공지 (1단락)**' (무엇이 바뀌나 + 왜 — 솔직하게), '**영향 (bullets)**' (사용자가 잃는 것), '**대안 / 마이그레이션 (bullets)**' (어떻게 옮겨가나 — 구체적), '**타임라인 (1줄)**' (주요 날짜), '**도움 (1줄)**' (질문 / 지원 경로), '**톤 (1줄)**' (사과보다 배려 + 명확). 신뢰 보호 우선.\n\n폐기 컨텍스트:\n${text}`,
  internal_engineering_principles_ko: (text) =>
    `Write Korean engineering principles — a small set of durable principles that guide how the team builds. Use 합쇼체. Markdown: '**한 줄 (왜 원칙)**' (1줄), '**원칙 (numbered)**' (4-6개, 각 '**원칙명 (1줄)**' + 설명 2줄 + '적용 예' 1줄 + 트레이드오프 — 'A를 B보다'), '**적용 (bullets)**' (실제 결정에 어떻게), '**원칙 아님 (1줄)**' (규칙/슬로건과 구분). 트레이드오프를 담아 실제 판단에 쓰이게.\n\n엔지니어링 컨텍스트:\n${text}`,
  translate_ko_to_kpelle: (text) =>
    `Translate the Korean text below into natural Kpelle — a Mande language of Liberia and Guinea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kpelle**' and '**번역 노트**' (3 bullets in Korean — note Kpelle is the most widely spoken indigenous language of Liberia, with its own syllabary).\n\n원문:\n${text}`,
  translate_ko_to_loma: (text) =>
    `Translate the Korean text below into natural Loma (Löömàgòòi) — a Mande language of Liberia and Guinea. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Loma**' and '**번역 노트**' (3 bullets in Korean — note Loma is a Southwestern Mande language that historically had its own indigenous script).\n\n원문:\n${text}`,
  translate_ko_to_vai: (text) =>
    `Translate the Korean text below into natural Vai — a Mande language of Liberia and Sierra Leone. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**ꕙꔤ (Vai)**' and '**번역 노트**' (3 bullets in Korean — note Vai is famous for the Vai syllabary, one of the few indigenous African scripts in active use).\n\n원문:\n${text}`,
  translate_ko_to_gola: (text) =>
    `Translate the Korean text below into natural Gola — a Mel (Atlantic-Congo) language of Liberia and Sierra Leone. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Gola**' and '**번역 노트**' (3 bullets in Korean — note Gola is a Mel language, not Mande, despite its location among Mande languages).\n\n원문:\n${text}`,
  translate_ko_to_kissi: (text) =>
    `Translate the Korean text below into natural Kissi — a Mel (Atlantic-Congo) language of Guinea, Sierra Leone and Liberia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kissi**' and '**번역 노트**' (3 bullets in Korean — note Kissi is a Mel language of the border tri-point region, written in Latin script).\n\n원문:\n${text}`,
  internal_service_catalog_entry_ko: (text) =>
    `Write a Korean service catalog entry — documents one service so others know what it is and how to use it. Use 합쇼체. Markdown: '**한 줄 (서비스)**' (1줄 — 무엇을 하나), '**소유 (bullets)**' (팀 / 온콜 / 연락처), '**책임 / 비책임 (bullets)**', '**API / 인터페이스 (bullets)**' (어떻게 호출 / 문서 링크), '**의존성 (bullets)**' (이게 의존하는 / 이걸 의존하는), '**SLO (1줄)**' (가용성 / 지연 목표), '**런북 / 대시보드 (bullets)**' (링크), '**온보딩 (1줄)**' (쓰려면 무엇부터). 한눈에 파악되게.\n\n서비스 컨텍스트:\n${text}`,
  sales_pipeline_generation_plan_ko: (text) =>
    `Write a Korean pipeline generation plan — a plan to build enough new pipeline to hit targets. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 필요 파이프라인 + 기간), '**갭 분석 (1줄)**' (목표 vs 현재 + 필요 배수), '**소스별 계획 (테이블)**' ('소스 | 목표 기여 | 활동 | 담당'): 아웃바운드 / 마케팅 / 파트너 / 기존확장, '**핵심 활동 (bullets)**' (구체적 — 콜드콜 수 / 캠페인 등), '**전환 가정 (bullets)**' (퍼널 단계별 비율), '**리스크 (bullets)**', '**주간 리듬 (1줄)**' (추적 방법). 숫자 역산.\n\n파이프라인 컨텍스트:\n${text}`,
  customer_health_improvement_plan_ko: (text) =>
    `Write a Korean customer health improvement plan — a focused plan to move a yellow/red account back to green. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 현재 → 목표 헬스), '**현재 헬스 진단 (테이블)**' ('요인 | 현재 | 문제'), '**근본 원인 (1단락)**', '**개선 액션 (테이블)**' ('액션 | 목표 지표 | 담당 | 시한'): 채택 / 가치 / 관계 / 지원, '**필요 자원 (bullets)**' (교육 / 임원 / 제품), '**성공 신호 (bullets)**' (초록 됐다는 증거), '**체크인 (1줄)**', '**리스크 (1줄)**'. 측정 가능한 회복 경로.\n\n헬스 컨텍스트:\n${text}`,
  pm_definition_of_ready_ko: (text) =>
    `Write a Korean Definition of Ready — the checklist a backlog item must meet before a team starts it. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄 — 왜 DoR이 필요한가), '**준비 기준 (체크 bullets)**' (사용자 가치 명확 / 인수 기준 / 디자인 / 의존성 확인 / 추정 / 테스트 가능), '**각 기준 설명 (테이블)**' ('기준 | 무엇을 의미 | 충족 예시'), '**예외 (1줄)**' (스파이크 등), '**책임 (1줄)**' (누가 준비 / 누가 확인), '**안티패턴 (1줄)**' (준비 안 된 채 시작). 명확하고 가벼운 게이트.\n\nDoR 컨텍스트:\n${text}`,
  internal_async_update_template_ko: (text) =>
    `Write a Korean async update template — a reusable template for written, async status updates. Use 합쇼체. Markdown: '**한 줄 (이번 업데이트)**' (1줄 — 🟢/🟡/🔴 + 핵심), '**진행 (bullets)**' (지난번 이후 한 것 — 결과 중심), '**다음 (bullets)**' (다음에 할 것), '**막힌 것 / 도움 필요 (bullets)**' (각 '무엇 — 누구에게 — 언제까지'), '**결정 / 변경 (bullets)**' (있으면), '**지표 / 링크 (1줄)**', '**작성 팁 (1줄)**' (스캔 가능 / 솔직 / 짧게). 동기 회의를 대체할 수 있게.\n\n업데이트 컨텍스트:\n${text}`,
  translate_ko_to_shilluk: (text) =>
    `Translate the Korean text below into natural Shilluk (Dhøg Cøllø) — a Luo (Western Nilotic) language of South Sudan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Dhøg Cøllø**' and '**번역 노트**' (3 bullets in Korean — note Shilluk is a Western Nilotic language with a complex tonal and vowel system).\n\n원문:\n${text}`,
  translate_ko_to_anuak: (text) =>
    `Translate the Korean text below into natural Anuak (Dha-Anywaa) — a Luo (Western Nilotic) language of the Ethiopia-South Sudan border. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Dha-Anywaa**' and '**번역 노트**' (3 bullets in Korean — note Anuak is a Western Nilotic language of the Gambela/Upper Nile region).\n\n원문:\n${text}`,
  translate_ko_to_bari: (text) =>
    `Translate the Korean text below into natural Bari — an Eastern Nilotic language of South Sudan around Juba. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Bari**' and '**번역 노트**' (3 bullets in Korean — note Bari is an Eastern Nilotic language of the central South Sudan region).\n\n원문:\n${text}`,
  translate_ko_to_lotuko: (text) =>
    `Translate the Korean text below into natural Otuho (Lotuko) — an Eastern Nilotic language of South Sudan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Otuho**' and '**번역 노트**' (3 bullets in Korean — note Otuho/Lotuko is an Eastern Nilotic language of the Eastern Equatoria region).\n\n원문:\n${text}`,
  translate_ko_to_zande: (text) =>
    `Translate the Korean text below into natural Zande (Pa-Zande) — a Ubangian (Niger-Congo) language of South Sudan, DR Congo and the Central African Republic. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Pa-Zande**' and '**번역 노트**' (3 bullets in Korean — note Zande is a Ubangian language of the Azande people, written in Latin script).\n\n원문:\n${text}`,
  internal_tech_radar_entry_ko: (text) =>
    `Write a Korean tech radar entry — assesses a technology/tool and places it on adopt/trial/assess/hold. Use 합쇼체. Markdown: '**한 줄 (판정)**' (1줄 — Adopt / Trial / Assess / Hold + 핵심 이유), '**기술 (1줄)**' (무엇 / 어디에 쓰는가), '**왜 보고 있나 (1단락)**' (어떤 문제를 풀어주나), '**강점 (bullets)**', '**우려 / 리스크 (bullets)**' (성숙도 / 운영 / 락인), '**우리 컨텍스트 적합성 (1단락)**', '**권고 (1줄)**' (어디서 어떻게 시작/피할지), '**재검토 시점 (1줄)**'. 근거 기반 판단.\n\n기술 컨텍스트:\n${text}`,
  sales_deal_loss_notification_ko: (text) =>
    `Write a Korean deal loss notification — an internal note announcing a lost deal with key learnings. Use 합쇼체. 짧고 솔직. Markdown: '**한 줄 (로스)**' (1줄 — 어느 딜 / 규모 / 핵심 이유), '**상황 요약 (bullets)**' (경쟁 / 단계 / 기간), '**왜 잃었나 (bullets)**' (솔직 — 가격 / 핏 / 타이밍 / 프로세스), '**우리가 배운 것 (bullets)**' (반복 가능한 교훈), '**프로세스 개선 제안 (1줄)**', '**재공략 가능성 (1줄)**' (언제 / 어떻게). 비난 없이 학습 중심.\n\n로스 컨텍스트:\n${text}`,
  customer_relationship_review_ko: (text) =>
    `Write a Korean customer relationship review — assesses the depth and health of relationships within an account. Use 합쇼체. Markdown: '**한 줄 (관계 건강)**' (1줄), '**관계 맵 요약 (테이블)**' ('인물 | 역할 | 관계 강도 | 마지막 접촉'), '**챔피언 상태 (bullets)**' (견고 / 흔들림 / 부재), '**커버리지 갭 (bullets)**' (관계 없는 핵심 인물), '**단일 의존 리스크 (1줄)**' (한 명에 의존?), '**최근 신호 (bullets)**' (관계 변화), '**강화 액션 (테이블)**' ('대상 | 액션 | 담당'), '**멀티스레딩 목표 (1줄)**'. 관계 다변화 강조.\n\n관계 컨텍스트:\n${text}`,
  pm_problem_statement_ko: (text) =>
    `Write a Korean problem statement — frames a problem sharply before any solutioning. Use 합쇼체. Markdown: '**한 줄 (문제)**' (1줄 — 한 문장으로 문제 정의), '**누가 (bullets)**' (영향받는 사람 / 세그먼트), '**현재 상황 (1단락)**' (지금 어떻게 / 왜 아픈가), '**증거 (bullets)**' (이게 진짜 문제라는 데이터), '**임팩트 (1줄)**' (안 풀면 / 풀면 — 가능하면 수치), '**제약 (bullets)**' (풀 때 지켜야 할 것), '**성공 기준 (bullets)**' (풀렸다는 것을 어떻게 아나), '**비범위 (1줄)**'. 솔루션 언급 금지 — 문제에 집중.\n\n문제 컨텍스트:\n${text}`,
  internal_handover_doc_ko: (text) =>
    `Write a Korean handover doc — hands off ownership of a project/area to someone else. Use 합쇼체. Markdown: '**한 줄 (인계)**' (1줄 — 무엇을 / 누구에게), '**개요 (1단락)**' (이 영역이 무엇 / 현재 상태), '**진행 중 작업 (테이블)**' ('작업 | 상태 | 다음 단계 | 마감'), '**핵심 컨텍스트 (bullets)**' (배경 / 결정 / 함정), '**연락처 (테이블)**' ('영역 | 누구 | 무엇 때문에'), '**접근 / 권한 (bullets)**' (필요한 것), '**리스크 / 주의 (bullets)**', '**리소스 링크 (bullets)**', '**첫 2주 추천 (1줄)**'. 인수자가 막힘 없이 이어가게.\n\n인계 컨텍스트:\n${text}`,
  translate_ko_to_ainu: (text) =>
    `Translate the Korean text below into natural Ainu (アイヌ・イタㇰ) — the indigenous language of Hokkaido, Japan. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Aynu itak**' (Latin transcription, optionally Katakana) and '**번역 노트**' (3 bullets in Korean — note Ainu is a critically endangered language isolate with a rich oral epic (yukar) tradition).\n\n원문:\n${text}`,
  translate_ko_to_nivkh: (text) =>
    `Translate the Korean text below into natural Nivkh (Gilyak) — a Paleosiberian language isolate of Sakhalin and the Amur estuary. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Nivkh**' and '**번역 노트**' (3 bullets in Korean — note Nivkh is a language isolate with an elaborate counting system; written in Cyrillic).\n\n원문:\n${text}`,
  translate_ko_to_chukchi: (text) =>
    `Translate the Korean text below into natural Chukchi (Ԓыгъоравэтԓьэн) — a Chukotko-Kamchatkan language of the Chukotka Peninsula, far northeastern Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Chukchi**' and '**번역 노트**' (3 bullets in Korean — note Chukchi is polysynthetic and historically had distinct men's and women's pronunciations; written in Cyrillic).\n\n원문:\n${text}`,
  translate_ko_to_koryak: (text) =>
    `Translate the Korean text below into natural Koryak — a Chukotko-Kamchatkan language of the Kamchatka region, Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Koryak**' and '**번역 노트**' (3 bullets in Korean — note Koryak is closely related to Chukchi, written in Cyrillic).\n\n원문:\n${text}`,
  translate_ko_to_itelmen: (text) =>
    `Translate the Korean text below into natural Itelmen (Kamchadal) — a Chukotko-Kamchatkan language of Kamchatka, Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Itelmen**' and '**번역 노트**' (3 bullets in Korean — note Itelmen is critically endangered with a notably large consonant inventory; written in Cyrillic).\n\n원문:\n${text}`,
  internal_observability_plan_ko: (text) =>
    `Write a Korean observability plan — plans the logs/metrics/traces needed to operate a service. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 무엇을 관측 / 어떤 질문에 답), '**핵심 질문 (bullets)**' (장애 시 답해야 할 것), '**메트릭 (테이블)**' ('메트릭 | 유형 | 알림 임계'): 골든 시그널(지연/트래픽/오류/포화), '**로그 (bullets)**' (무엇을 / 구조화 / 보존), '**트레이스 (1줄)**' (분산 추적 범위), '**대시보드 (bullets)**' (누구를 위한 무슨 뷰), '**알림 (bullets)**' (증상 기반 / 노이즈 방지), '**SLO 연계 (1줄)**'. 질문에서 출발.\n\n관측성 컨텍스트:\n${text}`,
  sales_pipeline_hygiene_review_ko: (text) =>
    `Write a Korean pipeline hygiene review — audits pipeline data quality and stuck deals. Use 합쇼체. Markdown: '**한 줄 (위생)**' (1줄 — 전반 건강 + 핵심 이슈), '**데이터 품질 (bullets)**' (오래된 단계 / 누락 필드 / 비현실 클로즈일), '**정체 딜 (테이블)**' ('딜 | 단계 | 정체 기간 | 액션(전진/다음분기/폐기)'), '**유령 파이프라인 (bullets)**' (실제 없는데 잡힌 것), '**단계 정의 점검 (1줄)**' (이탈/진입 기준 준수), '**정리 액션 (테이블)**' ('액션 | 담당 | 시한'), '**위생 규칙 (bullets)**' (앞으로). 정확한 예측 위한 청소.\n\n파이프라인 컨텍스트:\n${text}`,
  customer_kickoff_summary_email_ko: (text) =>
    `Draft a Korean kickoff summary email — sent after an onboarding kickoff to confirm alignment. Use 합쇼체 (따뜻 + 명확). Markdown: '**제목**' (1줄), '**본문**' (3-4 단락: 1) 킥오프 감사 + 핵심 1줄 요약, 2) 합의한 목표/성공 기준 재확인, 3) 다음 단계 + 일정 + 양측 액션, 4) 담당자 + 도움 제안), '**액션 아이템 (테이블)**' ('액션 | 담당(우리/고객) | 시한'), '**다음 마일스톤 (1줄)**'. 고객에게 바로 보낼 수 있게.\n\n킥오프 컨텍스트:\n${text}`,
  pm_metrics_review_monthly_ko: (text) =>
    `Write a Korean monthly product metrics review — reviews product health metrics month over month. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 건강 + 핵심 추세), '**핵심 지표 (테이블)**' ('지표 | 지난달 | 이번달 | 변화 | 비고'): 노스스타 / 활성 / 리텐션 / 채택 / 전환, '**잘 되는 것 (bullets)**', '**우려 (bullets)**' (각 '지표 — 가능 원인'), '**세그먼트/코호트 인사이트 (bullets)**', '**가설 (bullets)**' (다음에 검증할 것), '**액션 (테이블)**' ('액션 | 담당'), '**주의 (1줄)**' (지표 해석 함정). 데이터 → 가설 → 액션.\n\n지표 컨텍스트:\n${text}`,
  internal_onboarding_plan_eng_ko: (text) =>
    `Write a Korean engineer onboarding plan — a structured first-90-days plan specifically for a new engineer. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 90일 후 모습), '**1주차 (bullets)**' (환경 셋업 / 첫 커밋 / 사람 만나기), '**2-4주차 (bullets)**' (작은 작업 독립 완수 / 코드베이스 이해), '**2개월차 (bullets)**' (기능 단위 오너십), '**3개월차 (bullets)**' (온콜 합류 / 설계 참여), '**마일스톤 (테이블)**' ('시점 | 기대 | 멘토'), '**리소스 (bullets)**' (런북 / 아키텍처 / 용어집), '**조기 신호 (1줄)**'. 점진적 + 안전하게.\n\n신규 엔지니어 컨텍스트:\n${text}`,
  translate_ko_to_aleut: (text) =>
    `Translate the Korean text below into natural Aleut (Unangam Tunuu) — an Eskimo-Aleut language of the Aleutian Islands, Alaska and Russia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Unangam Tunuu**' and '**번역 노트**' (3 bullets in Korean — note Aleut is the sole surviving branch of the Aleut side of Eskimo-Aleut, written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_yupik: (text) =>
    `Translate the Korean text below into natural Central Alaskan Yup'ik — an Eskimo-Aleut language of southwestern Alaska. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Yup'ik**' and '**번역 노트**' (3 bullets in Korean — note Central Yup'ik is one of the most-spoken Native languages of Alaska, highly polysynthetic).\n\n원문:\n${text}`,
  translate_ko_to_inupiaq: (text) =>
    `Translate the Korean text below into natural Iñupiaq — an Inuit (Eskimo-Aleut) language of northern Alaska. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Iñupiaq**' and '**번역 노트**' (3 bullets in Korean — note Iñupiaq is part of the Inuit dialect continuum stretching across the Arctic, written in Latin script).\n\n원문:\n${text}`,
  translate_ko_to_alutiiq: (text) =>
    `Translate the Korean text below into natural Alutiiq (Sugpiaq) — an Eskimo-Aleut (Yupik) language of south-central coastal Alaska. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Sugt'stun**' and '**번역 노트**' (3 bullets in Korean — note Alutiiq is a Yupik language of the Kodiak and Alaska Peninsula coast).\n\n원문:\n${text}`,
  translate_ko_to_tlingit: (text) =>
    `Translate the Korean text below into natural Tlingit (Lingít) — a Na-Dene language of southeastern Alaska and northwestern Canada. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Lingít**' and '**번역 노트**' (3 bullets in Korean — note Tlingit is a tonal Na-Dene language with one of the largest consonant inventories in the Americas).\n\n원문:\n${text}`,
  internal_eng_health_review_ko: (text) =>
    `Write a Korean engineering health review — a holistic review of an eng team's technical and delivery health. Use 합쇼체. Markdown: '**한 줄 (건강)**' (1줄 — 종합 + 핵심), '**전달 (bullets)**' (속도 / 예측성 / 품질), '**시스템 건강 (테이블)**' ('영역 | 상태 | 추세'): 신뢰성 / 성능 / 기술부채 / 보안, '**개발자 경험 (bullets)**' (빌드 / 배포 / toil / 사기), '**리스크 (bullets)**' (단일 의존 / 부채 누적), '**잘 되는 것 (bullets)**', '**개선 우선순위 (테이블)**' ('항목 | 영향 | 담당'), '**다음 검토 (1줄)**'. 균형 잡힌 진단.\n\n엔지니어링 건강 컨텍스트:\n${text}`,
  sales_competitive_intel_update_ko: (text) =>
    `Write a Korean competitive intelligence update — a periodic update on competitor moves for the field. Use 합쇼체. Markdown: '**한 줄 (핵심)**' (1줄 — 이번 기간 가장 중요한 경쟁 동향), '**경쟁사별 동향 (테이블)**' ('경쟁사 | 변화(제품/가격/포지셔닝) | 우리 영향 | 대응'), '**새 위협 (bullets)**', '**새 기회 (bullets)**' (그들의 약점/실수), '**필드 가이드 업데이트 (bullets)**' (배틀카드 변경점), '**우리가 강조할 메시지 (1줄)**', '**출처 (1줄)**' (신뢰도 표기). 추측은 표시, 행동 가능하게.\n\n경쟁 인텔 컨텍스트:\n${text}`,
  customer_executive_sponsor_update_ko: (text) =>
    `Draft a Korean executive sponsor update — a periodic update to an account's executive sponsor. Use 합쇼체 (간결 + 가치 + 격조). Markdown: '**제목**' (1줄), '**본문**' (3 단락: 1) 인사 + 지난 기간 핵심 성과 1-2줄(데이터), 2) 진행 / 다음 마일스톤 + 그들 비즈니스에 주는 의미, 3) 후원 요청 또는 전략 제안 1개 — 명확히), '**한눈 성과 (bullets)**' (2-3개 지표), '**다음 접점 (1줄)**'. 임원 시간 존중, 150단어 내외.\n\n스폰서 업데이트 컨텍스트:\n${text}`,
  pm_product_health_review_ko: (text) =>
    `Write a Korean product health review — a holistic review of a product's overall health. Use 합쇼체. Markdown: '**한 줄 (건강)**' (1줄 — 종합 + 핵심 신호), '**핵심 지표 (테이블)**' ('지표 | 현재 | 추세 | 목표'): 노스스타 / 리텐션 / 활성 / NPS / 매출, '**사용자 신호 (bullets)**' (피드백 / 지원 / 이탈), '**제품 영역별 상태 (bullets)**' (어디가 건강/병약), '**리스크 (bullets)**', '**기회 (bullets)**', '**우선 액션 (테이블)**' ('액션 | 근거 | 담당'), '**다음 검토 (1줄)**'. 지표 + 정성 신호 종합.\n\n제품 건강 컨텍스트:\n${text}`,
  internal_eng_hiring_plan_ko: (text) =>
    `Write a Korean engineering hiring plan — plans hiring for an eng team over a period. Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 몇 명 / 어떤 역할 / 언제까지), '**필요 분석 (bullets)**' (왜 — 캐파갭 / 스킬갭 / 성장), '**역할 (테이블)**' ('역할 | 레벨 | 핵심 스킬 | 우선순위 | 목표 시점'), '**소싱 전략 (bullets)**' (채널 / 추천 / 다양성), '**인터뷰 프로세스 (1줄)**' (루프 / 기준), '**온보딩 준비 (bullets)**', '**리스크 (bullets)**' (시장 / 예산 / 시간), '**측정 (1줄)**' (퍼널 / 시간). 현실적 + 품질 우선.\n\n채용 컨텍스트:\n${text}`,
  translate_ko_to_haida: (text) =>
    `Translate the Korean text below into natural Haida (X̱aat Kíl) — a language isolate of Haida Gwaii (British Columbia) and southeastern Alaska. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**X̱aat Kíl**' and '**번역 노트**' (3 bullets in Korean — note Haida is a critically endangered language isolate, written in Latin script with special characters).\n\n원문:\n${text}`,
  translate_ko_to_tsimshian: (text) =>
    `Translate the Korean text below into natural Tsimshian (Sm'algyax) — a language of coastal British Columbia and southeastern Alaska. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Sm'algyax**' and '**번역 노트**' (3 bullets in Korean — note Sm'algyax is a Tsimshianic language of the Pacific Northwest coast).\n\n원문:\n${text}`,
  translate_ko_to_kwakwala: (text) =>
    `Translate the Korean text below into natural Kwak'wala — a Wakashan language of northern Vancouver Island and the adjacent BC mainland. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Kwak'wala**' and '**번역 노트**' (3 bullets in Korean — note Kwak'wala is a Wakashan language of the Kwakwaka'wakw peoples).\n\n원문:\n${text}`,
  translate_ko_to_salish: (text) =>
    `Translate the Korean text below into natural Halkomelem (a Coast Salish language) of southwestern British Columbia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Hən̓q̓əmin̓əm̓**' and '**번역 노트**' (3 bullets in Korean — note this is a Coast Salish language; pick a widely-used Halkomelem standard).\n\n원문:\n${text}`,
  translate_ko_to_nuuchahnulth: (text) =>
    `Translate the Korean text below into natural Nuu-chah-nulth (Nuučaan̓uł) — a Wakashan language of western Vancouver Island, BC. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Nuučaan̓uł**' and '**번역 노트**' (3 bullets in Korean — note Nuu-chah-nulth is a Southern Wakashan language with a large consonant inventory).\n\n원문:\n${text}`,
  internal_runbook_audit_ko: (text) =>
    `Write a Korean runbook audit — reviews existing runbooks for accuracy, coverage and freshness. Use 합쇼체. Markdown: '**한 줄 (총평)**' (1줄 — 런북 건강 + 핵심 갭), '**런북 목록 (테이블)**' ('런북 | 마지막 업데이트 | 정확성 | 커버리지 | 판정'), '**누락된 런북 (bullets)**' (있어야 하는데 없는 시나리오), '**오래된/부정확 (bullets)**' (검증 실패), '**중복/통합 후보 (bullets)**', '**개선 액션 (테이블)**' ('액션 | 담당 | 시한'), '**유지 관리 규칙 (1줄)**' (검토 주기). 실제 사고 때 작동하게.\n\n런북 컨텍스트:\n${text}`,
  sales_account_tiering_ko: (text) =>
    `Write a Korean account tiering framework — segments accounts into tiers to allocate effort. Use 합쇼체. Markdown: '**한 줄 (목적)**' (1줄), '**티어 기준 (테이블)**' ('티어 | 기준(ARR/성장/전략) | 서비스 수준 | 접촉 빈도'): A/B/C, '**티어별 플레이 (bullets)**' (각 티어에 무엇을 제공), '**리소스 배분 (1줄)**' (시간/사람), '**승급/강등 규칙 (bullets)**' (티어 이동 트리거), '**리스크 (1줄)**' (저티어 방치), '**적용 예시 (bullets)**'. 집중 + 형평 균형.\n\n계정 컨텍스트:\n${text}`,
  customer_executive_review_prep_ko: (text) =>
    `Write a Korean executive review prep doc — internal prep before an exec-level customer review (EBR). Use 합쇼체. Markdown: '**한 줄 (목표)**' (1줄 — 이 리뷰에서 얻을 것), '**참석 임원 (bullets)**' ('이름 — 역할 — 관심사 / 알아둘 점'), '**보여줄 전략 가치 (bullets)**' (C레벨 언어), '**비즈니스 임팩트 데이터 (bullets)**', '**예상 임원 질문 + 답 (테이블)**', '**민감 이슈 (bullets)**' (지뢰 + 대응), '**원하는 결과 (1줄)**' (후원 / 확장 / 레퍼런스), '**역할 분담 (테이블)**'. 내부 솔직 버전.\n\n리뷰 컨텍스트:\n${text}`,
  pm_user_segmentation_ko: (text) =>
    `Write a Korean user segmentation analysis — defines meaningful user segments to inform product decisions. Use 합쇼체. Markdown: '**한 줄 (핵심)**' (1줄 — 가장 중요한 세그먼트 구분), '**세그먼트 기준 (1줄)**' (무엇으로 나누나 — 행동/니즈/가치), '**세그먼트 (테이블)**' ('세그먼트 | 정의 | 규모 | 핵심 니즈 | 가치/수익성'), '**세그먼트별 행동 차이 (bullets)**', '**우선 세그먼트 (1줄)**' (집중할 곳 + 이유), '**시사점 (bullets)**' (제품 / GTM), '**주의 (1줄)**' (과도한 세분화 경계). 행동 기반 우선.\n\n세그먼트 컨텍스트:\n${text}`,
  internal_team_ritual_design_ko: (text) =>
    `Write a Korean team ritual design doc — designs a recurring team ritual (standup, planning, retro, demo) intentionally. Use 합쇼체. Markdown: '**한 줄 (의식)**' (1줄 — 무슨 리추얼 / 목적), '**왜 (1줄)**' (이게 풀어야 할 문제), '**형식 (테이블)**' ('항목 | 설정'): 주기 / 길이 / 참석자 / 진행자, '**아젠다 (numbered)**', '**산출물 (bullets)**' (끝나고 무엇이 남나), '**잘 돌아가는 신호 (bullets)**', '**안티패턴 (bullets)**' (의미 없어지는 징후 + 대응), '**점검 (1줄)**' (언제 이 리추얼 자체를 재검토). 목적 없는 회의 방지.\n\n리추얼 컨텍스트:\n${text}`,
  translate_ko_to_garifuna: (text) =>
    `Translate the Korean text below into natural Garifuna — an Arawakan language of the Caribbean coast of Central America (Honduras, Belize, Guatemala). 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Garifuna**' and '**번역 노트**' (3 bullets in Korean — note Garifuna is an Arawakan language with Carib and African influence, with distinct men's and women's vocabulary historically).\n\n원문:\n${text}`,
  translate_ko_to_miskito: (text) =>
    `Translate the Korean text below into natural Miskito — a Misumalpan language of the Caribbean coast of Nicaragua and Honduras. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Miskito**' and '**번역 노트**' (3 bullets in Korean — note Miskito is the most widely spoken indigenous language of the Mosquito Coast, with English loanwords).\n\n원문:\n${text}`,
  translate_ko_to_kuna: (text) =>
    `Translate the Korean text below into natural Guna (Kuna / Dulegaya) — a Chibchan language of the Guna Yala region of Panama and Colombia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Dulegaya**' and '**번역 노트**' (3 bullets in Korean — note Guna is a Chibchan language of the San Blas islands, known for mola textile art).\n\n원문:\n${text}`,
  translate_ko_to_embera: (text) =>
    `Translate the Korean text below into natural Emberá — a Chocoan language of Panama and Colombia. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Emberá**' and '**번역 노트**' (3 bullets in Korean — note Emberá is a Chocoan language of the Darién and Pacific rainforest regions).\n\n원문:\n${text}`,
  translate_ko_to_ngabere: (text) =>
    `Translate the Korean text below into natural Ngäbere (Guaymí) — a Chibchan language of western Panama and Costa Rica. 격식 (정중 표준) 원문에 맞춤. Reply with two sections: '**Ngäbere**' and '**번역 노트**' (3 bullets in Korean — note Ngäbere is the most widely spoken indigenous language of Panama, a Chibchan language).\n\n원문:\n${text}`,
  internal_incident_trends_review_ko: (text) =>
    `Write a Korean incident trends review — analyzes incident frequency and patterns over a period. Use 합쇼체. Markdown: '**한 줄 (추세)**' (1줄 — 빈도/심각도 방향 + 핵심), '**통계 (테이블)**' ('지표 | 이번 기간 | 지난 기간 | 변화'): 총 건수 / SEV별 / MTTR / 재발률, '**패턴 (테이블)**' ('패턴 | 빈도 | 대표 사례'), '**핫스팟 (bullets)**' (자주 터지는 영역/서비스), '**개선 효과 (1줄)**' (지난 액션이 효과 있었나), '**구조적 권고 (bullets)**', '**액션 (테이블)**' ('액션 | 담당 | 시한'). 개별 사고 너머 패턴.\n\n인시던트 추세 컨텍스트:\n${text}`,
  sales_quota_planning_ko: (text) =>
    `Write a Korean sales quota plan — sets and justifies sales quotas for a team/period. Use 합쇼체. Markdown: '**한 줄 (쿼터)**' (1줄 — 총 목표 + 기준), '**전제 (bullets)**' (시장 / 캐파 / 전환율 가정), '**배분 (테이블)**' ('담당 | 쿼터 | 근거(영역/램프/세그먼트)'), '**램프 고려 (bullets)**' (신규 인원 조정), '**달성 가능성 (1줄)**' (스트레치 vs 현실), '**리스크 (bullets)**', '**보상 연계 (1줄)**', '**점검 주기 (1줄)**'. 공정성 + 동기부여 균형.\n\n쿼터 컨텍스트:\n${text}`,
  customer_onboarding_completion_review_ko: (text) =>
    `Write a Korean onboarding completion review — assesses whether onboarding succeeded and transitions to ongoing CS. Use 합쇼체. Markdown: '**한 줄 (완료 상태)**' (1줄 — 성공/부분/지연 + 핵심), '**목표 달성 (테이블)**' ('온보딩 목표 | 달성 여부 | 비고'), '**Time-to-value (1줄)**' (목표 대비), '**고객 만족 신호 (bullets)**', '**미완 / 이월 (bullets)**' (정상 CS로 넘길 것), '**리스크 (1줄)**' (안착 실패 신호), '**핸드오프 to CS (bullets)**' (정상 운영팀에 넘길 컨텍스트), '**다음 마일스톤 (1줄)**'. 온보딩 → 안착 전환 명확히.\n\n온보딩 완료 컨텍스트:\n${text}`,
  pm_feature_postlaunch_review_ko: (text) =>
    `Write a Korean feature post-launch review — reviews how a feature performed after launch against its goals. Use 합쇼체. Markdown: '**한 줄 (결과)**' (1줄 — 성공/혼합/미달 + 핵심), '**목표 대비 (테이블)**' ('지표 | 목표 | 실제 | 달성도'), '**채택 (bullets)**' (얼마나 / 누가 쓰나), '**사용자 반응 (bullets)**' (피드백 / 지원), '**예상 밖 (bullets)**' (의외의 사용/문제), '**가설 검증 (1줄)**' (출시 가설 맞았나), '**다음 (bullets)**' (개선 / 확대 / 폐기), '**교훈 (1줄)**'. 정직한 사후 평가.\n\n출시 후 컨텍스트:\n${text}`,
  internal_decision_postmortem_ko: (text) =>
    `Write a Korean decision postmortem — reviews a past significant decision to learn how to decide better. Use 합쇼체. 결과가 아닌 의사결정 과정 중심. Markdown: '**한 줄 (결정)**' (1줄 — 무슨 결정 / 결과), '**당시 맥락 (1단락)**' (무엇을 알았고 몰랐나 — 사후확신 편향 경계), '**결정 과정 (bullets)**' (어떻게 정했나 / 누가 / 무슨 근거), '**결과 (bullets)**' (실제로 어떻게 됐나), '**좋은 결정 vs 좋은 결과 (1줄)**' (과정과 운 구분), '**프로세스 교훈 (bullets)**' (다음엔 어떻게 더 잘 결정), '**적용 (1줄)**'. 결과 탓이 아닌 과정 학습.\n\n결정 컨텍스트:\n${text}`,
  d_series_completion_announcement_ko: (text) =>
    `Write a Korean internal announcement celebrating the completion of a very large, sustained multi-phase build initiative. Use 해요체. 따뜻 + 진심 + 가식 없이. Markdown: '**제목**' (1줄, 28자 이내 — '[이니셔티브] 완주 — 끝까지 해냈어요'), '**본문**' (4 단락: 1) 한 줄 — '오늘 우리는 [이니셔티브]를 끝까지 완성했습니다', 2) 이 규모가 왜 대단한지 1단락 — 끈기 / 일관성 / 누적된 노력, 3) 호명 + 구체적 기여 — 입력에 있는 이름만, 각 '@이름 — 무엇을 한 1줄', 4) 다음 — '잠시 멈춰 자축하고, 다음으로'), '**감사 (1줄)**' (모두에게).\n\n이니셔티브 + 기여자:\n${text}`,
  full_program_celebration_ko: (text) =>
    `Write a Korean reflective program-completion celebration note for finishing a long, multi-stage program (the kind shared at an all-hands or in a team channel). Use 해요체. 진정성 + 회고 + 겸손. Markdown: '**한 줄 (마일스톤)**' (1줄 — 무엇을 완성했는지), '**여정 회고 (1단락)**' (4-5줄 — 어디서 시작해, 얼마나 길었고, 어떤 고비를 지나, 어떻게 끝까지 왔는지), '**우리가 배운 것 (3 bullets)**' (구체적 — 인내 / 일관성 / 시스템), '**기여한 사람들 (1단락)**' (입력에 있는 이름만 호명), '**다음 (1줄)**' (이 완주가 연 다음 가능성), '**감사 (1줄)**' (진심으로). 이모지는 절제해서.\n\n프로그램 컨텍스트:\n${text}`,
  translate_ko_to_classical_chinese: (text) =>
    `Translate the following Korean text into Classical Chinese (漢文 / 文言文), the literary language of premodern East Asia — NOT modern Mandarin vernacular. Use authentic classical grammar and characters. Provide: the 漢文 rendering, then a Korean 독음 gloss line, then a 1-line Korean note on any term with no classical equivalent. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ko_to_old_norse: (text) =>
    `Translate the following Korean text into Old Norse, the medieval North Germanic language of the Icelandic sagas. Use proper Old Norse orthography (þ, ð, æ, ǫ) and grammar. Provide: the Old Norse text, then a romanized pronunciation line, then a short Korean note on words you had to approximate. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ko_to_egyptian_arabic: (text) =>
    `Translate the following Korean text into Egyptian Arabic (Masri) as actually spoken in Cairo — NOT Modern Standard Arabic. Use everyday colloquial vocabulary and phrasing. Provide: the Arabic script, then a Latin transliteration, then a 1-line Korean note on register. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ko_to_gulf_arabic: (text) =>
    `Translate the following Korean text into Gulf Arabic (Khaleeji) as spoken across the Gulf states — NOT MSA. Use authentic Gulf colloquial features. Provide: the Arabic script, a Latin transliteration, and a 1-line Korean note on any regionalisms. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ko_to_bavarian: (text) =>
    `Translate the following Korean text into Bavarian (Boarisch), the Upper German dialect of Bavaria and Austria — NOT Standard German. Use authentic Bavarian spelling and vocabulary. Provide: the Bavarian text, then a Standard German gloss line, then a 1-line Korean note. Output only the translation block.\n\nKorean text:\n${text}`,
  incident_postmortem_detailed_ko: (text) =>
    `Write a detailed Korean engineering incident postmortem (장애 회고). 비난 없는(blameless) 톤, 객관적 사실 중심. Markdown 섹션: '**요약**' (1-2줄 — 무슨 장애가 언제, 영향 범위), '**영향**' (영향받은 사용자/지표 — 가능하면 수치), '**타임라인**' (감지 → 대응 → 복구, 시각 + 행동 bullets), '**근본 원인**' (1단락 — 왜 발생했는지), '**대응 / 복구**' (어떻게 해결했는지), '**재발 방지 (Action Items)**' (체크박스 + 담당 표기), '**배운 점**' (2-3 bullets). 입력에 있는 사실만 사용하고, 모르는 값은 'TBD'로.\n\n장애 정보:\n${text}`,
  vendor_evaluation_memo_ko: (text) =>
    `Write a Korean vendor/solution evaluation memo (벤더 평가 메모) for an internal purchasing decision. 객관적이고 의사결정 지향적인 톤. Markdown: '**평가 대상**' (벤더/제품명 + 한 줄 목적), '**평가 기준**' (기능/비용/보안/지원/확장성 — 입력 기준 위주), '**후보 비교**' (표: 항목 | 후보A | 후보B …), '**장단점**' (각 후보별 bullets), '**리스크**' (도입 시 우려), '**권고안**' (1단락 — 추천 + 근거), '**다음 단계**' (체크박스). 입력에 있는 정보만 사용.\n\n평가 컨텍스트:\n${text}`,
  sprint_review_script_ko: (text) =>
    `Write a Korean sprint review / demo presentation script (스프린트 리뷰 발표 스크립트) for a PM or engineer presenting completed work to stakeholders. 자연스러운 구어체(해요체). Markdown: '**오프닝 (30초)**' (스프린트 목표 한 줄 + 무엇을 보여줄지), '**데모 흐름**' (기능별 — 무엇을 / 왜 중요한지 / 어떻게 보여줄지, 입력 기능 순서대로), '**성과 수치**' (있으면), '**다음 스프린트 예고 (1줄)**', '**Q&A 대비 (예상 질문 3개 + 답변 1줄씩)**'. 입력에 있는 작업만.\n\n스프린트 내용:\n${text}`,
  hiring_scorecard_ko: (text) =>
    `Write a Korean interview scorecard / 평가표 template for evaluating a candidate after an interview. 공정하고 구조화된 톤. Markdown: '**지원자 / 포지션**' (1줄), '**평가 역량**' (입력의 직무 기준으로 4-6개 역량 — 각 역량별 정의 1줄 + 4점 척도 기준), '**인터뷰 노트**' (관찰 근거를 적는 빈 칸 안내), '**종합 점수 / 추천**' (Strong Hire / Hire / No Hire / Strong No Hire 중 택1 + 근거 1단락), '**후속 확인 사항**' (다음 라운드에서 검증할 점). 입력에 있는 직무/역량만.\n\n포지션 정보:\n${text}`,
  customer_success_qbr_ko: (text) =>
    `Write a Korean Quarterly Business Review (QBR) outline for a Customer Success Manager presenting to a key account. 신뢰감 + 가치 입증 톤. Markdown: '**분기 요약 (1줄)**', '**달성한 가치 / 성과**' (지표 + 비즈니스 임팩트 — 입력 데이터 기반), '**제품 활용 현황**' (사용량/도입 기능 bullets), '**오픈 이슈 / 리스크**' (해결 상태 포함), '**다음 분기 목표**' (체크박스), '**확장 / 갱신 제안 (1단락)**'. 입력에 있는 사실만, 수치 없으면 '데이터 확인 필요'로 표기.\n\n계정 정보:\n${text}`,
  translate_eap_l1: (text) =>
    `Translate the following Korean text into Friulian (Romance, NE Italy). Use authentic, natural Friulian as a fluent speaker would write it. Provide the Friulian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eap_l2: (text) =>
    `Translate the following Korean text into Occitan (Romance, southern France). Use authentic, natural Occitan as a fluent speaker would write it. Provide the Occitan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eap_l3: (text) =>
    `Translate the following Korean text into Breton (Celtic, Brittany). Use authentic, natural Breton as a fluent speaker would write it. Provide the Breton translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eap_l4: (text) =>
    `Translate the following Korean text into Cornish (Celtic, Cornwall). Use authentic, natural Cornish as a fluent speaker would write it. Provide the Cornish translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eap_l5: (text) =>
    `Translate the following Korean text into Manx (Celtic, Isle of Man). Use authentic, natural Manx as a fluent speaker would write it. Provide the Manx translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eap_d1: (text) =>
    `Write a Korean 배포 노트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 이번 배포 하이라이트, 새 기능, 개선 사항, 버그 수정, 알림 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eap_d2: (text) =>
    `Write a Korean 채용 공고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 포지션 소개, 주요 업무, 자격 요건, 우대 사항, 복리후생, 지원 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eap_d3: (text) =>
    `Write a Korean 영업 제안 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 인사, 고객 과제 공감, 제안 가치, 다음 단계(CTA) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eap_d4: (text) =>
    `Write a Korean 온보딩 가이드. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 환영 메시지, 첫주 할 일 체크리스트, 주요 도구, 도움을 받을 곳 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eap_d5: (text) =>
    `Write a Korean 성과 평가 자기서술. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 핵심 성과, 기여도, 성장 영역, 다음 분기 목표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_ebe_l1: (text) =>
    `Translate the following Korean text into Galician (Romance, NW Spain). Use authentic, natural Galician as a fluent speaker would write it. Provide the Galician translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ebe_l2: (text) =>
    `Translate the following Korean text into Asturian (Romance, Asturias). Use authentic, natural Asturian as a fluent speaker would write it. Provide the Asturian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ebe_l3: (text) =>
    `Translate the following Korean text into Aromanian (Eastern Romance, Balkans). Use authentic, natural Aromanian as a fluent speaker would write it. Provide the Aromanian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ebe_l4: (text) =>
    `Translate the following Korean text into Ladino (Judeo-Spanish). Use authentic, natural Ladino as a fluent speaker would write it. Provide the Ladino translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ebe_l5: (text) =>
    `Translate the following Korean text into Tatar (Turkic, Volga). Use authentic, natural Tatar as a fluent speaker would write it. Provide the Tatar translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_ebe_d1: (text) =>
    `Write a Korean OKR 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 목표(Objective), 핵심 결과(Key Results 3개), 이니셔티브, 측정 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ebe_d2: (text) =>
    `Write a Korean 기술 설계 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 배경, 목표와 비목표, 제안 아키텍처, 대안 비교, 트레이드오프, 롤아웃 계획 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ebe_d3: (text) =>
    `Write a Korean 사용자 인터뷰 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목표, 도입 질문, 핵심 질문(경험/행동 기반), 마무리 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ebe_d4: (text) =>
    `Write a Korean 경쟁사 분석. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비교 대상, 평가 축, 강점/약점 표, 시사점, 대응 전략 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ebe_d5: (text) =>
    `Write a Korean 에스컬레이션 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 영향도, 요청 사항, 기한, 필요 지원 구성으로 (차분하고 명확하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_ebt_l1: (text) =>
    `Translate the following Korean text into Bashkir (Turkic, Urals). Use authentic, natural Bashkir as a fluent speaker would write it. Provide the Bashkir translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ebt_l2: (text) =>
    `Translate the following Korean text into Chuvash (Turkic, Volga). Use authentic, natural Chuvash as a fluent speaker would write it. Provide the Chuvash translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ebt_l3: (text) =>
    `Translate the following Korean text into Tuvan (Turkic, Siberia). Use authentic, natural Tuvan as a fluent speaker would write it. Provide the Tuvan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ebt_l4: (text) =>
    `Translate the following Korean text into Buryat (Mongolic, Lake Baikal). Use authentic, natural Buryat as a fluent speaker would write it. Provide the Buryat translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ebt_l5: (text) =>
    `Translate the following Korean text into Kalmyk (Mongolic, Caspian steppe). Use authentic, natural Kalmyk as a fluent speaker would write it. Provide the Kalmyk translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_ebt_d1: (text) =>
    `Write a Korean 로드맵 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비전, 분기별 테마, 주요 마일스톤, 의존성, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ebt_d2: (text) =>
    `Write a Korean 스프린트 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 잘 된 점(Keep), 개선할 점(Problem), 시도할 점(Try) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ebt_d3: (text) =>
    `Write a Korean 의사결정 메모. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 결정 사항, 배경, 고려한 대안, 근거, 후속 조치 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ebt_d4: (text) =>
    `Write a Korean FAQ 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 주제 소개, 질문-답변 쌍(빈도 높은 순), 추가 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ebt_d5: (text) =>
    `Write a Korean 보도자료. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 헤드라인, 리드 문단, 본문(세부/인용), 회사 소개(boilerplate), 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eci_l1: (text) =>
    `Translate the following Korean text into Udmurt (Uralic, Volga). Use authentic, natural Udmurt as a fluent speaker would write it. Provide the Udmurt translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eci_l2: (text) =>
    `Translate the following Korean text into Mari (Uralic, Volga). Use authentic, natural Mari as a fluent speaker would write it. Provide the Mari translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eci_l3: (text) =>
    `Translate the following Korean text into Komi (Uralic, NE Europe). Use authentic, natural Komi as a fluent speaker would write it. Provide the Komi translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eci_l4: (text) =>
    `Translate the following Korean text into Erzya (Uralic, Mordovia). Use authentic, natural Erzya as a fluent speaker would write it. Provide the Erzya translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eci_l5: (text) =>
    `Translate the following Korean text into Northern Sami (Uralic, Sápmi). Use authentic, natural Northern Sami as a fluent speaker would write it. Provide the Northern Sami translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eci_d1: (text) =>
    `Write a Korean 기능 스펙 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 개요, 사용자 스토리, 수용 기준(AC), 엣지 케이스, 추적 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eci_d2: (text) =>
    `Write a Korean 해지/종료 안내문. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 변경 요약, 사유, 적용 일정, 사용자 영향, 대체 안내 구성으로 (정중하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eci_d3: (text) =>
    `Write a Korean 가격 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제공 범위, 가격 옵션(표), 포함/불포함, 결제 조건, 유효기간 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eci_d4: (text) =>
    `Write a Korean 백로그 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 요약(TL;DR), 본문 구조(소제목 3-5개), 마무리, CTA 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eci_d5: (text) =>
    `Write a Korean 고객 설문 설계. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적, 대상, 질문 문항(객관식/주관식 혼합), 참여 안내 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_ecx_l1: (text) =>
    `Translate the following Korean text into Karelian (Uralic, Karelia). Use authentic, natural Karelian as a fluent speaker would write it. Provide the Karelian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ecx_l2: (text) =>
    `Translate the following Korean text into Ingush (Northeast Caucasian). Use authentic, natural Ingush as a fluent speaker would write it. Provide the Ingush translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ecx_l3: (text) =>
    `Translate the following Korean text into Avar (Northeast Caucasian, Dagestan). Use authentic, natural Avar as a fluent speaker would write it. Provide the Avar translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ecx_l4: (text) =>
    `Translate the following Korean text into Lezgian (Northeast Caucasian). Use authentic, natural Lezgian as a fluent speaker would write it. Provide the Lezgian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ecx_l5: (text) =>
    `Translate the following Korean text into Ossetian (Eastern Iranian, Caucasus). Use authentic, natural Ossetian as a fluent speaker would write it. Provide the Ossetian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_ecx_d1: (text) =>
    `Write a Korean 대외 발표 소개글. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 훅(hook), 핵심 메시지, 근거 3가지, 행동 제안 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ecx_d2: (text) =>
    `Write a Korean 분기 사업 리뷰(QBR). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 요약, 달성 성과, 활용 현황, 오픈 이슈, 다음 분기 목표 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ecx_d3: (text) =>
    `Write a Korean 장애 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 요약, 영향, 타임라인, 근본 원인, 재발 방지 책임(비난 없는 톤) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ecx_d4: (text) =>
    `Write a Korean 뉴스레터 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 인트로, 주요 소식 3개, 팁/링크, 마무리 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ecx_d5: (text) =>
    `Write a Korean 면접 평가표. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지원자/포지션, 평가 역량(4-6개, 척도 포함), 인터뷰 노트, 종합 추천 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_edm_l1: (text) =>
    `Translate the following Korean text into Tajik (Persian variety, Tajikistan). Use authentic, natural Tajik as a fluent speaker would write it. Provide the Tajik translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_edm_l2: (text) =>
    `Translate the following Korean text into Pashto (Eastern Iranian, Afghanistan). Use authentic, natural Pashto as a fluent speaker would write it. Provide the Pashto translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_edm_l3: (text) =>
    `Translate the following Korean text into Balochi (Iranian, Balochistan). Use authentic, natural Balochi as a fluent speaker would write it. Provide the Balochi translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_edm_l4: (text) =>
    `Translate the following Korean text into Kurdish Sorani (Iranian, Iraq/Iran). Use authentic, natural Kurdish Sorani as a fluent speaker would write it. Provide the Kurdish Sorani translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_edm_l5: (text) =>
    `Translate the following Korean text into Sindhi (Indo-Aryan, Pakistan/India). Use authentic, natural Sindhi as a fluent speaker would write it. Provide the Sindhi translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_edm_d1: (text) =>
    `Write a Korean 기획 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적/배경, 핵심 제안, 기대 효과, 일정, 리소스, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_edm_d2: (text) =>
    `Write a Korean 주간 업무 보고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지난주 성과, 이번주 계획, 이슈/블로커, 도움 요청 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_edm_d3: (text) =>
    `Write a Korean 회의록. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 일시/참석자, 안건, 논의 요점, 결정 사항, Action Item(담당/기한) 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_edm_d4: (text) =>
    `Write a Korean 제품 요구사항 문서(PRD). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 문제 정의, 목표, 사용자 시나리오, 기능 요구, 비기능 요구, 성공 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_edm_d5: (text) =>
    `Write a Korean 고객 응대 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 공감 멘트, 해결 안내, 대안 제시, 마무리 인사 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eeb_l1: (text) =>
    `Translate the following Korean text into Konkani (Indo-Aryan, Goa). Use authentic, natural Konkani as a fluent speaker would write it. Provide the Konkani translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eeb_l2: (text) =>
    `Translate the following Korean text into Tulu (Dravidian, Karnataka). Use authentic, natural Tulu as a fluent speaker would write it. Provide the Tulu translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eeb_l3: (text) =>
    `Translate the following Korean text into Santali (Munda, eastern India). Use authentic, natural Santali as a fluent speaker would write it. Provide the Santali translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eeb_l4: (text) =>
    `Translate the following Korean text into Meitei (Tibeto-Burman, Manipur). Use authentic, natural Meitei as a fluent speaker would write it. Provide the Meitei translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eeb_l5: (text) =>
    `Translate the following Korean text into Dzongkha (Tibetic, Bhutan). Use authentic, natural Dzongkha as a fluent speaker would write it. Provide the Dzongkha translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eeb_d1: (text) =>
    `Write a Korean 배포 노트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 이번 배포 하이라이트, 새 기능, 개선 사항, 버그 수정, 알림 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eeb_d2: (text) =>
    `Write a Korean 채용 공고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 포지션 소개, 주요 업무, 자격 요건, 우대 사항, 복리후생, 지원 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eeb_d3: (text) =>
    `Write a Korean 영업 제안 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 인사, 고객 과제 공감, 제안 가치, 다음 단계(CTA) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eeb_d4: (text) =>
    `Write a Korean 온보딩 가이드. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 환영 메시지, 첫주 할 일 체크리스트, 주요 도구, 도움을 받을 곳 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eeb_d5: (text) =>
    `Write a Korean 성과 평가 자기서술. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 핵심 성과, 기여도, 성장 영역, 다음 분기 목표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eer_l1: (text) =>
    `Translate the following Korean text into Newar (Tibeto-Burman, Nepal). Use authentic, natural Newar as a fluent speaker would write it. Provide the Newar translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eer_l2: (text) =>
    `Translate the following Korean text into Shan (Tai, Myanmar). Use authentic, natural Shan as a fluent speaker would write it. Provide the Shan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eer_l3: (text) =>
    `Translate the following Korean text into Hmong (Hmong-Mien, SE Asia). Use authentic, natural Hmong as a fluent speaker would write it. Provide the Hmong translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eer_l4: (text) =>
    `Translate the following Korean text into Cham (Austronesian, Vietnam/Cambodia). Use authentic, natural Cham as a fluent speaker would write it. Provide the Cham translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eer_l5: (text) =>
    `Translate the following Korean text into Acehnese (Austronesian, Sumatra). Use authentic, natural Acehnese as a fluent speaker would write it. Provide the Acehnese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eer_d1: (text) =>
    `Write a Korean OKR 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 목표(Objective), 핵심 결과(Key Results 3개), 이니셔티브, 측정 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eer_d2: (text) =>
    `Write a Korean 기술 설계 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 배경, 목표와 비목표, 제안 아키텍처, 대안 비교, 트레이드오프, 롤아웃 계획 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eer_d3: (text) =>
    `Write a Korean 사용자 인터뷰 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목표, 도입 질문, 핵심 질문(경험/행동 기반), 마무리 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eer_d4: (text) =>
    `Write a Korean 경쟁사 분석. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비교 대상, 평가 축, 강점/약점 표, 시사점, 대응 전략 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eer_d5: (text) =>
    `Write a Korean 에스컬레이션 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 영향도, 요청 사항, 기한, 필요 지원 구성으로 (차분하고 명확하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_efg_l1: (text) =>
    `Translate the following Korean text into Minangkabau (Austronesian, Sumatra). Use authentic, natural Minangkabau as a fluent speaker would write it. Provide the Minangkabau translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_efg_l2: (text) =>
    `Translate the following Korean text into Buginese (Austronesian, Sulawesi). Use authentic, natural Buginese as a fluent speaker would write it. Provide the Buginese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_efg_l3: (text) =>
    `Translate the following Korean text into Tetum (Austronesian, Timor-Leste). Use authentic, natural Tetum as a fluent speaker would write it. Provide the Tetum translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_efg_l4: (text) =>
    `Translate the following Korean text into Chamorro (Austronesian, Guam). Use authentic, natural Chamorro as a fluent speaker would write it. Provide the Chamorro translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_efg_l5: (text) =>
    `Translate the following Korean text into Marshallese (Micronesian). Use authentic, natural Marshallese as a fluent speaker would write it. Provide the Marshallese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_efg_d1: (text) =>
    `Write a Korean 로드맵 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비전, 분기별 테마, 주요 마일스톤, 의존성, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_efg_d2: (text) =>
    `Write a Korean 스프린트 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 잘 된 점(Keep), 개선할 점(Problem), 시도할 점(Try) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_efg_d3: (text) =>
    `Write a Korean 의사결정 메모. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 결정 사항, 배경, 고려한 대안, 근거, 후속 조치 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_efg_d4: (text) =>
    `Write a Korean FAQ 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 주제 소개, 질문-답변 쌍(빈도 높은 순), 추가 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_efg_d5: (text) =>
    `Write a Korean 보도자료. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 헤드라인, 리드 문단, 본문(세부/인용), 회사 소개(boilerplate), 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_efv_l1: (text) =>
    `Translate the following Korean text into Gilbertese (Micronesian, Kiribati). Use authentic, natural Gilbertese as a fluent speaker would write it. Provide the Gilbertese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_efv_l2: (text) =>
    `Translate the following Korean text into Fijian (Oceanic, Fiji). Use authentic, natural Fijian as a fluent speaker would write it. Provide the Fijian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_efv_l3: (text) =>
    `Translate the following Korean text into Tongan (Polynesian, Tonga). Use authentic, natural Tongan as a fluent speaker would write it. Provide the Tongan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_efv_l4: (text) =>
    `Translate the following Korean text into Tahitian (Polynesian). Use authentic, natural Tahitian as a fluent speaker would write it. Provide the Tahitian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_efv_l5: (text) =>
    `Translate the following Korean text into Marquesan (Polynesian). Use authentic, natural Marquesan as a fluent speaker would write it. Provide the Marquesan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_efv_d1: (text) =>
    `Write a Korean 기능 스펙 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 개요, 사용자 스토리, 수용 기준(AC), 엣지 케이스, 추적 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_efv_d2: (text) =>
    `Write a Korean 해지/종료 안내문. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 변경 요약, 사유, 적용 일정, 사용자 영향, 대체 안내 구성으로 (정중하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_efv_d3: (text) =>
    `Write a Korean 가격 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제공 범위, 가격 옵션(표), 포함/불포함, 결제 조건, 유효기간 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_efv_d4: (text) =>
    `Write a Korean 백로그 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 요약(TL;DR), 본문 구조(소제목 3-5개), 마무리, CTA 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_efv_d5: (text) =>
    `Write a Korean 고객 설문 설계. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적, 대상, 질문 문항(객관식/주관식 혼합), 참여 안내 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_egk_l1: (text) =>
    `Translate the following Korean text into Rapa Nui (Polynesian, Easter Island). Use authentic, natural Rapa Nui as a fluent speaker would write it. Provide the Rapa Nui translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_egk_l2: (text) =>
    `Translate the following Korean text into Bislama (English creole, Vanuatu). Use authentic, natural Bislama as a fluent speaker would write it. Provide the Bislama translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_egk_l3: (text) =>
    `Translate the following Korean text into Tok Pisin (English creole, Papua New Guinea). Use authentic, natural Tok Pisin as a fluent speaker would write it. Provide the Tok Pisin translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_egk_l4: (text) =>
    `Translate the following Korean text into Hiri Motu (pidgin, Papua New Guinea). Use authentic, natural Hiri Motu as a fluent speaker would write it. Provide the Hiri Motu translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_egk_l5: (text) =>
    `Translate the following Korean text into Palauan (Austronesian, Palau). Use authentic, natural Palauan as a fluent speaker would write it. Provide the Palauan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_egk_d1: (text) =>
    `Write a Korean 대외 발표 소개글. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 훅(hook), 핵심 메시지, 근거 3가지, 행동 제안 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_egk_d2: (text) =>
    `Write a Korean 분기 사업 리뷰(QBR). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 요약, 달성 성과, 활용 현황, 오픈 이슈, 다음 분기 목표 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_egk_d3: (text) =>
    `Write a Korean 장애 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 요약, 영향, 타임라인, 근본 원인, 재발 방지 책임(비난 없는 톤) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_egk_d4: (text) =>
    `Write a Korean 뉴스레터 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 인트로, 주요 소식 3개, 팁/링크, 마무리 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_egk_d5: (text) =>
    `Write a Korean 면접 평가표. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지원자/포지션, 평가 역량(4-6개, 척도 포함), 인터뷰 노트, 종합 추천 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_egz_l1: (text) =>
    `Translate the following Korean text into Yapese (Austronesian, Yap). Use authentic, natural Yapese as a fluent speaker would write it. Provide the Yapese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_egz_l2: (text) =>
    `Translate the following Korean text into Nahuatl (Uto-Aztecan, Mexico). Use authentic, natural Nahuatl as a fluent speaker would write it. Provide the Nahuatl translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_egz_l3: (text) =>
    `Translate the following Korean text into Quechua (Andean, Peru). Use authentic, natural Quechua as a fluent speaker would write it. Provide the Quechua translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_egz_l4: (text) =>
    `Translate the following Korean text into Aymara (Andean, Bolivia). Use authentic, natural Aymara as a fluent speaker would write it. Provide the Aymara translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_egz_l5: (text) =>
    `Translate the following Korean text into Guarani (Tupian, Paraguay). Use authentic, natural Guarani as a fluent speaker would write it. Provide the Guarani translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_egz_d1: (text) =>
    `Write a Korean 기획 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적/배경, 핵심 제안, 기대 효과, 일정, 리소스, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_egz_d2: (text) =>
    `Write a Korean 주간 업무 보고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지난주 성과, 이번주 계획, 이슈/블로커, 도움 요청 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_egz_d3: (text) =>
    `Write a Korean 회의록. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 일시/참석자, 안건, 논의 요점, 결정 사항, Action Item(담당/기한) 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_egz_d4: (text) =>
    `Write a Korean 제품 요구사항 문서(PRD). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 문제 정의, 목표, 사용자 시나리오, 기능 요구, 비기능 요구, 성공 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_egz_d5: (text) =>
    `Write a Korean 고객 응대 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 공감 멘트, 해결 안내, 대안 제시, 마무리 인사 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eho_l1: (text) =>
    `Translate the following Korean text into Mapuche (Araucanian, Chile). Use authentic, natural Mapuche as a fluent speaker would write it. Provide the Mapuche translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eho_l2: (text) =>
    `Translate the following Korean text into Greenlandic Inuktitut (Inuit, Arctic Canada). Use authentic, natural Greenlandic Inuktitut as a fluent speaker would write it. Provide the Greenlandic Inuktitut translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eho_l3: (text) =>
    `Translate the following Korean text into Cree (Algonquian, Canada). Use authentic, natural Cree as a fluent speaker would write it. Provide the Cree translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eho_l4: (text) =>
    `Translate the following Korean text into Ojibwe (Algonquian, Great Lakes). Use authentic, natural Ojibwe as a fluent speaker would write it. Provide the Ojibwe translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eho_l5: (text) =>
    `Translate the following Korean text into Navajo (Athabaskan, US Southwest). Use authentic, natural Navajo as a fluent speaker would write it. Provide the Navajo translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eho_d1: (text) =>
    `Write a Korean 배포 노트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 이번 배포 하이라이트, 새 기능, 개선 사항, 버그 수정, 알림 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eho_d2: (text) =>
    `Write a Korean 채용 공고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 포지션 소개, 주요 업무, 자격 요건, 우대 사항, 복리후생, 지원 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eho_d3: (text) =>
    `Write a Korean 영업 제안 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 인사, 고객 과제 공감, 제안 가치, 다음 단계(CTA) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eho_d4: (text) =>
    `Write a Korean 온보딩 가이드. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 환영 메시지, 첫주 할 일 체크리스트, 주요 도구, 도움을 받을 곳 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eho_d5: (text) =>
    `Write a Korean 성과 평가 자기서술. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 핵심 성과, 기여도, 성장 영역, 다음 분기 목표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eid_l1: (text) =>
    `Translate the following Korean text into Cherokee (Iroquoian, US Southeast). Use authentic, natural Cherokee as a fluent speaker would write it. Provide the Cherokee translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eid_l2: (text) =>
    `Translate the following Korean text into Hawaiian (Polynesian, Hawaii). Use authentic, natural Hawaiian as a fluent speaker would write it. Provide the Hawaiian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eid_l3: (text) =>
    `Translate the following Korean text into Maori (Polynesian, New Zealand). Use authentic, natural Maori as a fluent speaker would write it. Provide the Maori translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eid_l4: (text) =>
    `Translate the following Korean text into Samoan (Polynesian, Samoa). Use authentic, natural Samoan as a fluent speaker would write it. Provide the Samoan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eid_l5: (text) =>
    `Translate the following Korean text into Wolof (Niger-Congo, Senegal). Use authentic, natural Wolof as a fluent speaker would write it. Provide the Wolof translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eid_d1: (text) =>
    `Write a Korean OKR 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 목표(Objective), 핵심 결과(Key Results 3개), 이니셔티브, 측정 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eid_d2: (text) =>
    `Write a Korean 기술 설계 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 배경, 목표와 비목표, 제안 아키텍처, 대안 비교, 트레이드오프, 롤아웃 계획 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eid_d3: (text) =>
    `Write a Korean 사용자 인터뷰 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목표, 도입 질문, 핵심 질문(경험/행동 기반), 마무리 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eid_d4: (text) =>
    `Write a Korean 경쟁사 분석. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비교 대상, 평가 축, 강점/약점 표, 시사점, 대응 전략 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eid_d5: (text) =>
    `Write a Korean 에스컬레이션 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 영향도, 요청 사항, 기한, 필요 지원 구성으로 (차분하고 명확하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eis_l1: (text) =>
    `Translate the following Korean text into Bambara (Mande, Mali). Use authentic, natural Bambara as a fluent speaker would write it. Provide the Bambara translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eis_l2: (text) =>
    `Translate the following Korean text into Fula (Niger-Congo, Sahel). Use authentic, natural Fula as a fluent speaker would write it. Provide the Fula translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eis_l3: (text) =>
    `Translate the following Korean text into Tigrinya (Semitic, Eritrea/Ethiopia). Use authentic, natural Tigrinya as a fluent speaker would write it. Provide the Tigrinya translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eis_l4: (text) =>
    `Translate the following Korean text into Amharic (Semitic, Ethiopia). Use authentic, natural Amharic as a fluent speaker would write it. Provide the Amharic translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eis_l5: (text) =>
    `Translate the following Korean text into Somali (Cushitic, Horn of Africa). Use authentic, natural Somali as a fluent speaker would write it. Provide the Somali translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eis_d1: (text) =>
    `Write a Korean 로드맵 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비전, 분기별 테마, 주요 마일스톤, 의존성, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eis_d2: (text) =>
    `Write a Korean 스프린트 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 잘 된 점(Keep), 개선할 점(Problem), 시도할 점(Try) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eis_d3: (text) =>
    `Write a Korean 의사결정 메모. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 결정 사항, 배경, 고려한 대안, 근거, 후속 조치 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eis_d4: (text) =>
    `Write a Korean FAQ 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 주제 소개, 질문-답변 쌍(빈도 높은 순), 추가 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eis_d5: (text) =>
    `Write a Korean 보도자료. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 헤드라인, 리드 문단, 본문(세부/인용), 회사 소개(boilerplate), 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_ejh_l1: (text) =>
    `Translate the following Korean text into Oromo (Cushitic, Ethiopia). Use authentic, natural Oromo as a fluent speaker would write it. Provide the Oromo translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ejh_l2: (text) =>
    `Translate the following Korean text into Shona (Bantu, Zimbabwe). Use authentic, natural Shona as a fluent speaker would write it. Provide the Shona translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ejh_l3: (text) =>
    `Translate the following Korean text into Sesotho (Bantu, Lesotho). Use authentic, natural Sesotho as a fluent speaker would write it. Provide the Sesotho translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ejh_l4: (text) =>
    `Translate the following Korean text into Tswana (Bantu, Botswana). Use authentic, natural Tswana as a fluent speaker would write it. Provide the Tswana translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ejh_l5: (text) =>
    `Translate the following Korean text into Kikuyu (Bantu, Kenya). Use authentic, natural Kikuyu as a fluent speaker would write it. Provide the Kikuyu translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_ejh_d1: (text) =>
    `Write a Korean 기능 스펙 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 개요, 사용자 스토리, 수용 기준(AC), 엣지 케이스, 추적 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ejh_d2: (text) =>
    `Write a Korean 해지/종료 안내문. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 변경 요약, 사유, 적용 일정, 사용자 영향, 대체 안내 구성으로 (정중하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ejh_d3: (text) =>
    `Write a Korean 가격 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제공 범위, 가격 옵션(표), 포함/불포함, 결제 조건, 유효기간 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ejh_d4: (text) =>
    `Write a Korean 백로그 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 요약(TL;DR), 본문 구조(소제목 3-5개), 마무리, CTA 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ejh_d5: (text) =>
    `Write a Korean 고객 설문 설계. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적, 대상, 질문 문항(객관식/주관식 혼합), 참여 안내 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_ejw_l1: (text) =>
    `Translate the following Korean text into Luganda (Bantu, Uganda). Use authentic, natural Luganda as a fluent speaker would write it. Provide the Luganda translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ejw_l2: (text) =>
    `Translate the following Korean text into Malagasy (Austronesian, Madagascar). Use authentic, natural Malagasy as a fluent speaker would write it. Provide the Malagasy translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ejw_l3: (text) =>
    `Translate the following Korean text into Faroese (North Germanic, Faroe Islands). Use authentic, natural Faroese as a fluent speaker would write it. Provide the Faroese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ejw_l4: (text) =>
    `Translate the following Korean text into Greenlandic (Kalaallisut, Eskimo-Aleut). Use authentic, natural Greenlandic as a fluent speaker would write it. Provide the Greenlandic translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ejw_l5: (text) =>
    `Translate the following Korean text into Luxembourgish (West Germanic, Lëtzebuergesch). Use authentic, natural Luxembourgish as a fluent speaker would write it. Provide the Luxembourgish translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_ejw_d1: (text) =>
    `Write a Korean 대외 발표 소개글. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 훅(hook), 핵심 메시지, 근거 3가지, 행동 제안 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ejw_d2: (text) =>
    `Write a Korean 분기 사업 리뷰(QBR). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 요약, 달성 성과, 활용 현황, 오픈 이슈, 다음 분기 목표 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ejw_d3: (text) =>
    `Write a Korean 장애 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 요약, 영향, 타임라인, 근본 원인, 재발 방지 책임(비난 없는 톤) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ejw_d4: (text) =>
    `Write a Korean 뉴스레터 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 인트로, 주요 소식 3개, 팁/링크, 마무리 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ejw_d5: (text) =>
    `Write a Korean 면접 평가표. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지원자/포지션, 평가 역량(4-6개, 척도 포함), 인터뷰 노트, 종합 추천 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_ekl_l1: (text) =>
    `Translate the following Korean text into Romansh (Rhaeto-Romance, Switzerland). Use authentic, natural Romansh as a fluent speaker would write it. Provide the Romansh translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ekl_l2: (text) =>
    `Translate the following Korean text into Sardinian (Romance, Sardinia). Use authentic, natural Sardinian as a fluent speaker would write it. Provide the Sardinian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ekl_l3: (text) =>
    `Translate the following Korean text into Friulian (Romance, NE Italy). Use authentic, natural Friulian as a fluent speaker would write it. Provide the Friulian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ekl_l4: (text) =>
    `Translate the following Korean text into Occitan (Romance, southern France). Use authentic, natural Occitan as a fluent speaker would write it. Provide the Occitan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ekl_l5: (text) =>
    `Translate the following Korean text into Breton (Celtic, Brittany). Use authentic, natural Breton as a fluent speaker would write it. Provide the Breton translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_ekl_d1: (text) =>
    `Write a Korean 기획 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적/배경, 핵심 제안, 기대 효과, 일정, 리소스, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ekl_d2: (text) =>
    `Write a Korean 주간 업무 보고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지난주 성과, 이번주 계획, 이슈/블로커, 도움 요청 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ekl_d3: (text) =>
    `Write a Korean 회의록. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 일시/참석자, 안건, 논의 요점, 결정 사항, Action Item(담당/기한) 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ekl_d4: (text) =>
    `Write a Korean 제품 요구사항 문서(PRD). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 문제 정의, 목표, 사용자 시나리오, 기능 요구, 비기능 요구, 성공 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ekl_d5: (text) =>
    `Write a Korean 고객 응대 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 공감 멘트, 해결 안내, 대안 제시, 마무리 인사 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_ela_l1: (text) =>
    `Translate the following Korean text into Cornish (Celtic, Cornwall). Use authentic, natural Cornish as a fluent speaker would write it. Provide the Cornish translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ela_l2: (text) =>
    `Translate the following Korean text into Manx (Celtic, Isle of Man). Use authentic, natural Manx as a fluent speaker would write it. Provide the Manx translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ela_l3: (text) =>
    `Translate the following Korean text into Galician (Romance, NW Spain). Use authentic, natural Galician as a fluent speaker would write it. Provide the Galician translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ela_l4: (text) =>
    `Translate the following Korean text into Asturian (Romance, Asturias). Use authentic, natural Asturian as a fluent speaker would write it. Provide the Asturian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ela_l5: (text) =>
    `Translate the following Korean text into Aromanian (Eastern Romance, Balkans). Use authentic, natural Aromanian as a fluent speaker would write it. Provide the Aromanian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_ela_d1: (text) =>
    `Write a Korean 배포 노트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 이번 배포 하이라이트, 새 기능, 개선 사항, 버그 수정, 알림 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ela_d2: (text) =>
    `Write a Korean 채용 공고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 포지션 소개, 주요 업무, 자격 요건, 우대 사항, 복리후생, 지원 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ela_d3: (text) =>
    `Write a Korean 영업 제안 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 인사, 고객 과제 공감, 제안 가치, 다음 단계(CTA) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ela_d4: (text) =>
    `Write a Korean 온보딩 가이드. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 환영 메시지, 첫주 할 일 체크리스트, 주요 도구, 도움을 받을 곳 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ela_d5: (text) =>
    `Write a Korean 성과 평가 자기서술. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 핵심 성과, 기여도, 성장 영역, 다음 분기 목표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_elp_l1: (text) =>
    `Translate the following Korean text into Ladino (Judeo-Spanish). Use authentic, natural Ladino as a fluent speaker would write it. Provide the Ladino translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_elp_l2: (text) =>
    `Translate the following Korean text into Tatar (Turkic, Volga). Use authentic, natural Tatar as a fluent speaker would write it. Provide the Tatar translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_elp_l3: (text) =>
    `Translate the following Korean text into Bashkir (Turkic, Urals). Use authentic, natural Bashkir as a fluent speaker would write it. Provide the Bashkir translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_elp_l4: (text) =>
    `Translate the following Korean text into Chuvash (Turkic, Volga). Use authentic, natural Chuvash as a fluent speaker would write it. Provide the Chuvash translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_elp_l5: (text) =>
    `Translate the following Korean text into Tuvan (Turkic, Siberia). Use authentic, natural Tuvan as a fluent speaker would write it. Provide the Tuvan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_elp_d1: (text) =>
    `Write a Korean OKR 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 목표(Objective), 핵심 결과(Key Results 3개), 이니셔티브, 측정 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_elp_d2: (text) =>
    `Write a Korean 기술 설계 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 배경, 목표와 비목표, 제안 아키텍처, 대안 비교, 트레이드오프, 롤아웃 계획 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_elp_d3: (text) =>
    `Write a Korean 사용자 인터뷰 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목표, 도입 질문, 핵심 질문(경험/행동 기반), 마무리 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_elp_d4: (text) =>
    `Write a Korean 경쟁사 분석. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비교 대상, 평가 축, 강점/약점 표, 시사점, 대응 전략 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_elp_d5: (text) =>
    `Write a Korean 에스컬레이션 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 영향도, 요청 사항, 기한, 필요 지원 구성으로 (차분하고 명확하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eme_l1: (text) =>
    `Translate the following Korean text into Buryat (Mongolic, Lake Baikal). Use authentic, natural Buryat as a fluent speaker would write it. Provide the Buryat translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eme_l2: (text) =>
    `Translate the following Korean text into Kalmyk (Mongolic, Caspian steppe). Use authentic, natural Kalmyk as a fluent speaker would write it. Provide the Kalmyk translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eme_l3: (text) =>
    `Translate the following Korean text into Udmurt (Uralic, Volga). Use authentic, natural Udmurt as a fluent speaker would write it. Provide the Udmurt translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eme_l4: (text) =>
    `Translate the following Korean text into Mari (Uralic, Volga). Use authentic, natural Mari as a fluent speaker would write it. Provide the Mari translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eme_l5: (text) =>
    `Translate the following Korean text into Komi (Uralic, NE Europe). Use authentic, natural Komi as a fluent speaker would write it. Provide the Komi translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eme_d1: (text) =>
    `Write a Korean 로드맵 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비전, 분기별 테마, 주요 마일스톤, 의존성, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eme_d2: (text) =>
    `Write a Korean 스프린트 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 잘 된 점(Keep), 개선할 점(Problem), 시도할 점(Try) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eme_d3: (text) =>
    `Write a Korean 의사결정 메모. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 결정 사항, 배경, 고려한 대안, 근거, 후속 조치 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eme_d4: (text) =>
    `Write a Korean FAQ 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 주제 소개, 질문-답변 쌍(빈도 높은 순), 추가 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eme_d5: (text) =>
    `Write a Korean 보도자료. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 헤드라인, 리드 문단, 본문(세부/인용), 회사 소개(boilerplate), 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_emt_l1: (text) =>
    `Translate the following Korean text into Erzya (Uralic, Mordovia). Use authentic, natural Erzya as a fluent speaker would write it. Provide the Erzya translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_emt_l2: (text) =>
    `Translate the following Korean text into Northern Sami (Uralic, Sápmi). Use authentic, natural Northern Sami as a fluent speaker would write it. Provide the Northern Sami translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_emt_l3: (text) =>
    `Translate the following Korean text into Karelian (Uralic, Karelia). Use authentic, natural Karelian as a fluent speaker would write it. Provide the Karelian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_emt_l4: (text) =>
    `Translate the following Korean text into Ingush (Northeast Caucasian). Use authentic, natural Ingush as a fluent speaker would write it. Provide the Ingush translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_emt_l5: (text) =>
    `Translate the following Korean text into Avar (Northeast Caucasian, Dagestan). Use authentic, natural Avar as a fluent speaker would write it. Provide the Avar translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_emt_d1: (text) =>
    `Write a Korean 기능 스펙 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 개요, 사용자 스토리, 수용 기준(AC), 엣지 케이스, 추적 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_emt_d2: (text) =>
    `Write a Korean 해지/종료 안내문. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 변경 요약, 사유, 적용 일정, 사용자 영향, 대체 안내 구성으로 (정중하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_emt_d3: (text) =>
    `Write a Korean 가격 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제공 범위, 가격 옵션(표), 포함/불포함, 결제 조건, 유효기간 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_emt_d4: (text) =>
    `Write a Korean 백로그 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 요약(TL;DR), 본문 구조(소제목 3-5개), 마무리, CTA 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_emt_d5: (text) =>
    `Write a Korean 고객 설문 설계. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적, 대상, 질문 문항(객관식/주관식 혼합), 참여 안내 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eni_l1: (text) =>
    `Translate the following Korean text into Lezgian (Northeast Caucasian). Use authentic, natural Lezgian as a fluent speaker would write it. Provide the Lezgian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eni_l2: (text) =>
    `Translate the following Korean text into Ossetian (Eastern Iranian, Caucasus). Use authentic, natural Ossetian as a fluent speaker would write it. Provide the Ossetian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eni_l3: (text) =>
    `Translate the following Korean text into Tajik (Persian variety, Tajikistan). Use authentic, natural Tajik as a fluent speaker would write it. Provide the Tajik translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eni_l4: (text) =>
    `Translate the following Korean text into Pashto (Eastern Iranian, Afghanistan). Use authentic, natural Pashto as a fluent speaker would write it. Provide the Pashto translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eni_l5: (text) =>
    `Translate the following Korean text into Balochi (Iranian, Balochistan). Use authentic, natural Balochi as a fluent speaker would write it. Provide the Balochi translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eni_d1: (text) =>
    `Write a Korean 대외 발표 소개글. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 훅(hook), 핵심 메시지, 근거 3가지, 행동 제안 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eni_d2: (text) =>
    `Write a Korean 분기 사업 리뷰(QBR). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 요약, 달성 성과, 활용 현황, 오픈 이슈, 다음 분기 목표 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eni_d3: (text) =>
    `Write a Korean 장애 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 요약, 영향, 타임라인, 근본 원인, 재발 방지 책임(비난 없는 톤) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eni_d4: (text) =>
    `Write a Korean 뉴스레터 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 인트로, 주요 소식 3개, 팁/링크, 마무리 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eni_d5: (text) =>
    `Write a Korean 면접 평가표. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지원자/포지션, 평가 역량(4-6개, 척도 포함), 인터뷰 노트, 종합 추천 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_enx_l1: (text) =>
    `Translate the following Korean text into Kurdish Sorani (Iranian, Iraq/Iran). Use authentic, natural Kurdish Sorani as a fluent speaker would write it. Provide the Kurdish Sorani translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_enx_l2: (text) =>
    `Translate the following Korean text into Sindhi (Indo-Aryan, Pakistan/India). Use authentic, natural Sindhi as a fluent speaker would write it. Provide the Sindhi translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_enx_l3: (text) =>
    `Translate the following Korean text into Konkani (Indo-Aryan, Goa). Use authentic, natural Konkani as a fluent speaker would write it. Provide the Konkani translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_enx_l4: (text) =>
    `Translate the following Korean text into Tulu (Dravidian, Karnataka). Use authentic, natural Tulu as a fluent speaker would write it. Provide the Tulu translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_enx_l5: (text) =>
    `Translate the following Korean text into Santali (Munda, eastern India). Use authentic, natural Santali as a fluent speaker would write it. Provide the Santali translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_enx_d1: (text) =>
    `Write a Korean 기획 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적/배경, 핵심 제안, 기대 효과, 일정, 리소스, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_enx_d2: (text) =>
    `Write a Korean 주간 업무 보고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지난주 성과, 이번주 계획, 이슈/블로커, 도움 요청 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_enx_d3: (text) =>
    `Write a Korean 회의록. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 일시/참석자, 안건, 논의 요점, 결정 사항, Action Item(담당/기한) 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_enx_d4: (text) =>
    `Write a Korean 제품 요구사항 문서(PRD). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 문제 정의, 목표, 사용자 시나리오, 기능 요구, 비기능 요구, 성공 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_enx_d5: (text) =>
    `Write a Korean 고객 응대 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 공감 멘트, 해결 안내, 대안 제시, 마무리 인사 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eom_l1: (text) =>
    `Translate the following Korean text into Meitei (Tibeto-Burman, Manipur). Use authentic, natural Meitei as a fluent speaker would write it. Provide the Meitei translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eom_l2: (text) =>
    `Translate the following Korean text into Dzongkha (Tibetic, Bhutan). Use authentic, natural Dzongkha as a fluent speaker would write it. Provide the Dzongkha translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eom_l3: (text) =>
    `Translate the following Korean text into Newar (Tibeto-Burman, Nepal). Use authentic, natural Newar as a fluent speaker would write it. Provide the Newar translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eom_l4: (text) =>
    `Translate the following Korean text into Shan (Tai, Myanmar). Use authentic, natural Shan as a fluent speaker would write it. Provide the Shan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eom_l5: (text) =>
    `Translate the following Korean text into Hmong (Hmong-Mien, SE Asia). Use authentic, natural Hmong as a fluent speaker would write it. Provide the Hmong translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eom_d1: (text) =>
    `Write a Korean 배포 노트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 이번 배포 하이라이트, 새 기능, 개선 사항, 버그 수정, 알림 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eom_d2: (text) =>
    `Write a Korean 채용 공고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 포지션 소개, 주요 업무, 자격 요건, 우대 사항, 복리후생, 지원 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eom_d3: (text) =>
    `Write a Korean 영업 제안 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 인사, 고객 과제 공감, 제안 가치, 다음 단계(CTA) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eom_d4: (text) =>
    `Write a Korean 온보딩 가이드. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 환영 메시지, 첫주 할 일 체크리스트, 주요 도구, 도움을 받을 곳 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eom_d5: (text) =>
    `Write a Korean 성과 평가 자기서술. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 핵심 성과, 기여도, 성장 영역, 다음 분기 목표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_epb_l1: (text) =>
    `Translate the following Korean text into Cham (Austronesian, Vietnam/Cambodia). Use authentic, natural Cham as a fluent speaker would write it. Provide the Cham translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_epb_l2: (text) =>
    `Translate the following Korean text into Acehnese (Austronesian, Sumatra). Use authentic, natural Acehnese as a fluent speaker would write it. Provide the Acehnese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_epb_l3: (text) =>
    `Translate the following Korean text into Minangkabau (Austronesian, Sumatra). Use authentic, natural Minangkabau as a fluent speaker would write it. Provide the Minangkabau translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_epb_l4: (text) =>
    `Translate the following Korean text into Buginese (Austronesian, Sulawesi). Use authentic, natural Buginese as a fluent speaker would write it. Provide the Buginese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_epb_l5: (text) =>
    `Translate the following Korean text into Tetum (Austronesian, Timor-Leste). Use authentic, natural Tetum as a fluent speaker would write it. Provide the Tetum translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_epb_d1: (text) =>
    `Write a Korean OKR 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 목표(Objective), 핵심 결과(Key Results 3개), 이니셔티브, 측정 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_epb_d2: (text) =>
    `Write a Korean 기술 설계 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 배경, 목표와 비목표, 제안 아키텍처, 대안 비교, 트레이드오프, 롤아웃 계획 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_epb_d3: (text) =>
    `Write a Korean 사용자 인터뷰 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목표, 도입 질문, 핵심 질문(경험/행동 기반), 마무리 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_epb_d4: (text) =>
    `Write a Korean 경쟁사 분석. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비교 대상, 평가 축, 강점/약점 표, 시사점, 대응 전략 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_epb_d5: (text) =>
    `Write a Korean 에스컬레이션 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 영향도, 요청 사항, 기한, 필요 지원 구성으로 (차분하고 명확하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_epq_l1: (text) =>
    `Translate the following Korean text into Chamorro (Austronesian, Guam). Use authentic, natural Chamorro as a fluent speaker would write it. Provide the Chamorro translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_epq_l2: (text) =>
    `Translate the following Korean text into Marshallese (Micronesian). Use authentic, natural Marshallese as a fluent speaker would write it. Provide the Marshallese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_epq_l3: (text) =>
    `Translate the following Korean text into Gilbertese (Micronesian, Kiribati). Use authentic, natural Gilbertese as a fluent speaker would write it. Provide the Gilbertese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_epq_l4: (text) =>
    `Translate the following Korean text into Fijian (Oceanic, Fiji). Use authentic, natural Fijian as a fluent speaker would write it. Provide the Fijian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_epq_l5: (text) =>
    `Translate the following Korean text into Tongan (Polynesian, Tonga). Use authentic, natural Tongan as a fluent speaker would write it. Provide the Tongan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_epq_d1: (text) =>
    `Write a Korean 로드맵 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비전, 분기별 테마, 주요 마일스톤, 의존성, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_epq_d2: (text) =>
    `Write a Korean 스프린트 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 잘 된 점(Keep), 개선할 점(Problem), 시도할 점(Try) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_epq_d3: (text) =>
    `Write a Korean 의사결정 메모. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 결정 사항, 배경, 고려한 대안, 근거, 후속 조치 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_epq_d4: (text) =>
    `Write a Korean FAQ 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 주제 소개, 질문-답변 쌍(빈도 높은 순), 추가 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_epq_d5: (text) =>
    `Write a Korean 보도자료. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 헤드라인, 리드 문단, 본문(세부/인용), 회사 소개(boilerplate), 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eqf_l1: (text) =>
    `Translate the following Korean text into Tahitian (Polynesian). Use authentic, natural Tahitian as a fluent speaker would write it. Provide the Tahitian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eqf_l2: (text) =>
    `Translate the following Korean text into Marquesan (Polynesian). Use authentic, natural Marquesan as a fluent speaker would write it. Provide the Marquesan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eqf_l3: (text) =>
    `Translate the following Korean text into Rapa Nui (Polynesian, Easter Island). Use authentic, natural Rapa Nui as a fluent speaker would write it. Provide the Rapa Nui translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eqf_l4: (text) =>
    `Translate the following Korean text into Bislama (English creole, Vanuatu). Use authentic, natural Bislama as a fluent speaker would write it. Provide the Bislama translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eqf_l5: (text) =>
    `Translate the following Korean text into Tok Pisin (English creole, Papua New Guinea). Use authentic, natural Tok Pisin as a fluent speaker would write it. Provide the Tok Pisin translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eqf_d1: (text) =>
    `Write a Korean 기능 스펙 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 개요, 사용자 스토리, 수용 기준(AC), 엣지 케이스, 추적 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eqf_d2: (text) =>
    `Write a Korean 해지/종료 안내문. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 변경 요약, 사유, 적용 일정, 사용자 영향, 대체 안내 구성으로 (정중하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eqf_d3: (text) =>
    `Write a Korean 가격 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제공 범위, 가격 옵션(표), 포함/불포함, 결제 조건, 유효기간 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eqf_d4: (text) =>
    `Write a Korean 백로그 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 요약(TL;DR), 본문 구조(소제목 3-5개), 마무리, CTA 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eqf_d5: (text) =>
    `Write a Korean 고객 설문 설계. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적, 대상, 질문 문항(객관식/주관식 혼합), 참여 안내 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_equ_l1: (text) =>
    `Translate the following Korean text into Hiri Motu (pidgin, Papua New Guinea). Use authentic, natural Hiri Motu as a fluent speaker would write it. Provide the Hiri Motu translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_equ_l2: (text) =>
    `Translate the following Korean text into Palauan (Austronesian, Palau). Use authentic, natural Palauan as a fluent speaker would write it. Provide the Palauan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_equ_l3: (text) =>
    `Translate the following Korean text into Yapese (Austronesian, Yap). Use authentic, natural Yapese as a fluent speaker would write it. Provide the Yapese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_equ_l4: (text) =>
    `Translate the following Korean text into Nahuatl (Uto-Aztecan, Mexico). Use authentic, natural Nahuatl as a fluent speaker would write it. Provide the Nahuatl translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_equ_l5: (text) =>
    `Translate the following Korean text into Quechua (Andean, Peru). Use authentic, natural Quechua as a fluent speaker would write it. Provide the Quechua translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_equ_d1: (text) =>
    `Write a Korean 대외 발표 소개글. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 훅(hook), 핵심 메시지, 근거 3가지, 행동 제안 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_equ_d2: (text) =>
    `Write a Korean 분기 사업 리뷰(QBR). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 요약, 달성 성과, 활용 현황, 오픈 이슈, 다음 분기 목표 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_equ_d3: (text) =>
    `Write a Korean 장애 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 요약, 영향, 타임라인, 근본 원인, 재발 방지 책임(비난 없는 톤) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_equ_d4: (text) =>
    `Write a Korean 뉴스레터 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 인트로, 주요 소식 3개, 팁/링크, 마무리 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_equ_d5: (text) =>
    `Write a Korean 면접 평가표. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지원자/포지션, 평가 역량(4-6개, 척도 포함), 인터뷰 노트, 종합 추천 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_erj_l1: (text) =>
    `Translate the following Korean text into Aymara (Andean, Bolivia). Use authentic, natural Aymara as a fluent speaker would write it. Provide the Aymara translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_erj_l2: (text) =>
    `Translate the following Korean text into Guarani (Tupian, Paraguay). Use authentic, natural Guarani as a fluent speaker would write it. Provide the Guarani translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_erj_l3: (text) =>
    `Translate the following Korean text into Mapuche (Araucanian, Chile). Use authentic, natural Mapuche as a fluent speaker would write it. Provide the Mapuche translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_erj_l4: (text) =>
    `Translate the following Korean text into Greenlandic Inuktitut (Inuit, Arctic Canada). Use authentic, natural Greenlandic Inuktitut as a fluent speaker would write it. Provide the Greenlandic Inuktitut translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_erj_l5: (text) =>
    `Translate the following Korean text into Cree (Algonquian, Canada). Use authentic, natural Cree as a fluent speaker would write it. Provide the Cree translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_erj_d1: (text) =>
    `Write a Korean 기획 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적/배경, 핵심 제안, 기대 효과, 일정, 리소스, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_erj_d2: (text) =>
    `Write a Korean 주간 업무 보고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지난주 성과, 이번주 계획, 이슈/블로커, 도움 요청 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_erj_d3: (text) =>
    `Write a Korean 회의록. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 일시/참석자, 안건, 논의 요점, 결정 사항, Action Item(담당/기한) 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_erj_d4: (text) =>
    `Write a Korean 제품 요구사항 문서(PRD). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 문제 정의, 목표, 사용자 시나리오, 기능 요구, 비기능 요구, 성공 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_erj_d5: (text) =>
    `Write a Korean 고객 응대 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 공감 멘트, 해결 안내, 대안 제시, 마무리 인사 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_ery_l1: (text) =>
    `Translate the following Korean text into Ojibwe (Algonquian, Great Lakes). Use authentic, natural Ojibwe as a fluent speaker would write it. Provide the Ojibwe translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ery_l2: (text) =>
    `Translate the following Korean text into Navajo (Athabaskan, US Southwest). Use authentic, natural Navajo as a fluent speaker would write it. Provide the Navajo translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ery_l3: (text) =>
    `Translate the following Korean text into Cherokee (Iroquoian, US Southeast). Use authentic, natural Cherokee as a fluent speaker would write it. Provide the Cherokee translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ery_l4: (text) =>
    `Translate the following Korean text into Hawaiian (Polynesian, Hawaii). Use authentic, natural Hawaiian as a fluent speaker would write it. Provide the Hawaiian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_ery_l5: (text) =>
    `Translate the following Korean text into Maori (Polynesian, New Zealand). Use authentic, natural Maori as a fluent speaker would write it. Provide the Maori translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_ery_d1: (text) =>
    `Write a Korean 배포 노트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 이번 배포 하이라이트, 새 기능, 개선 사항, 버그 수정, 알림 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ery_d2: (text) =>
    `Write a Korean 채용 공고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 포지션 소개, 주요 업무, 자격 요건, 우대 사항, 복리후생, 지원 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ery_d3: (text) =>
    `Write a Korean 영업 제안 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 인사, 고객 과제 공감, 제안 가치, 다음 단계(CTA) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ery_d4: (text) =>
    `Write a Korean 온보딩 가이드. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 환영 메시지, 첫주 할 일 체크리스트, 주요 도구, 도움을 받을 곳 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_ery_d5: (text) =>
    `Write a Korean 성과 평가 자기서술. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 핵심 성과, 기여도, 성장 영역, 다음 분기 목표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_esn_l1: (text) =>
    `Translate the following Korean text into Samoan (Polynesian, Samoa). Use authentic, natural Samoan as a fluent speaker would write it. Provide the Samoan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_esn_l2: (text) =>
    `Translate the following Korean text into Wolof (Niger-Congo, Senegal). Use authentic, natural Wolof as a fluent speaker would write it. Provide the Wolof translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_esn_l3: (text) =>
    `Translate the following Korean text into Bambara (Mande, Mali). Use authentic, natural Bambara as a fluent speaker would write it. Provide the Bambara translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_esn_l4: (text) =>
    `Translate the following Korean text into Fula (Niger-Congo, Sahel). Use authentic, natural Fula as a fluent speaker would write it. Provide the Fula translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_esn_l5: (text) =>
    `Translate the following Korean text into Tigrinya (Semitic, Eritrea/Ethiopia). Use authentic, natural Tigrinya as a fluent speaker would write it. Provide the Tigrinya translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_esn_d1: (text) =>
    `Write a Korean OKR 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 목표(Objective), 핵심 결과(Key Results 3개), 이니셔티브, 측정 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_esn_d2: (text) =>
    `Write a Korean 기술 설계 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 배경, 목표와 비목표, 제안 아키텍처, 대안 비교, 트레이드오프, 롤아웃 계획 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_esn_d3: (text) =>
    `Write a Korean 사용자 인터뷰 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목표, 도입 질문, 핵심 질문(경험/행동 기반), 마무리 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_esn_d4: (text) =>
    `Write a Korean 경쟁사 분석. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비교 대상, 평가 축, 강점/약점 표, 시사점, 대응 전략 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_esn_d5: (text) =>
    `Write a Korean 에스컬레이션 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 영향도, 요청 사항, 기한, 필요 지원 구성으로 (차분하고 명확하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_etc_l1: (text) =>
    `Translate the following Korean text into Amharic (Semitic, Ethiopia). Use authentic, natural Amharic as a fluent speaker would write it. Provide the Amharic translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_etc_l2: (text) =>
    `Translate the following Korean text into Somali (Cushitic, Horn of Africa). Use authentic, natural Somali as a fluent speaker would write it. Provide the Somali translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_etc_l3: (text) =>
    `Translate the following Korean text into Oromo (Cushitic, Ethiopia). Use authentic, natural Oromo as a fluent speaker would write it. Provide the Oromo translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_etc_l4: (text) =>
    `Translate the following Korean text into Shona (Bantu, Zimbabwe). Use authentic, natural Shona as a fluent speaker would write it. Provide the Shona translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_etc_l5: (text) =>
    `Translate the following Korean text into Sesotho (Bantu, Lesotho). Use authentic, natural Sesotho as a fluent speaker would write it. Provide the Sesotho translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_etc_d1: (text) =>
    `Write a Korean 로드맵 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비전, 분기별 테마, 주요 마일스톤, 의존성, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_etc_d2: (text) =>
    `Write a Korean 스프린트 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 잘 된 점(Keep), 개선할 점(Problem), 시도할 점(Try) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_etc_d3: (text) =>
    `Write a Korean 의사결정 메모. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 결정 사항, 배경, 고려한 대안, 근거, 후속 조치 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_etc_d4: (text) =>
    `Write a Korean FAQ 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 주제 소개, 질문-답변 쌍(빈도 높은 순), 추가 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_etc_d5: (text) =>
    `Write a Korean 보도자료. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 헤드라인, 리드 문단, 본문(세부/인용), 회사 소개(boilerplate), 문의처 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_etr_l1: (text) =>
    `Translate the following Korean text into Tswana (Bantu, Botswana). Use authentic, natural Tswana as a fluent speaker would write it. Provide the Tswana translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_etr_l2: (text) =>
    `Translate the following Korean text into Kikuyu (Bantu, Kenya). Use authentic, natural Kikuyu as a fluent speaker would write it. Provide the Kikuyu translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_etr_l3: (text) =>
    `Translate the following Korean text into Luganda (Bantu, Uganda). Use authentic, natural Luganda as a fluent speaker would write it. Provide the Luganda translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_etr_l4: (text) =>
    `Translate the following Korean text into Malagasy (Austronesian, Madagascar). Use authentic, natural Malagasy as a fluent speaker would write it. Provide the Malagasy translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_etr_l5: (text) =>
    `Translate the following Korean text into Faroese (North Germanic, Faroe Islands). Use authentic, natural Faroese as a fluent speaker would write it. Provide the Faroese translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_etr_d1: (text) =>
    `Write a Korean 기능 스펙 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 개요, 사용자 스토리, 수용 기준(AC), 엣지 케이스, 추적 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_etr_d2: (text) =>
    `Write a Korean 해지/종료 안내문. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 변경 요약, 사유, 적용 일정, 사용자 영향, 대체 안내 구성으로 (정중하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_etr_d3: (text) =>
    `Write a Korean 가격 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제공 범위, 가격 옵션(표), 포함/불포함, 결제 조건, 유효기간 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_etr_d4: (text) =>
    `Write a Korean 백로그 개요. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 요약(TL;DR), 본문 구조(소제목 3-5개), 마무리, CTA 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_etr_d5: (text) =>
    `Write a Korean 고객 설문 설계. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적, 대상, 질문 문항(객관식/주관식 혼합), 참여 안내 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_eug_l1: (text) =>
    `Translate the following Korean text into Greenlandic (Kalaallisut, Eskimo-Aleut). Use authentic, natural Greenlandic as a fluent speaker would write it. Provide the Greenlandic translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eug_l2: (text) =>
    `Translate the following Korean text into Luxembourgish (West Germanic, Lëtzebuergesch). Use authentic, natural Luxembourgish as a fluent speaker would write it. Provide the Luxembourgish translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eug_l3: (text) =>
    `Translate the following Korean text into Romansh (Rhaeto-Romance, Switzerland). Use authentic, natural Romansh as a fluent speaker would write it. Provide the Romansh translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eug_l4: (text) =>
    `Translate the following Korean text into Sardinian (Romance, Sardinia). Use authentic, natural Sardinian as a fluent speaker would write it. Provide the Sardinian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_eug_l5: (text) =>
    `Translate the following Korean text into Friulian (Romance, NE Italy). Use authentic, natural Friulian as a fluent speaker would write it. Provide the Friulian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_eug_d1: (text) =>
    `Write a Korean 대외 발표 소개글. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 훅(hook), 핵심 메시지, 근거 3가지, 행동 제안 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eug_d2: (text) =>
    `Write a Korean 분기 사업 리뷰(QBR). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 요약, 달성 성과, 활용 현황, 오픈 이슈, 다음 분기 목표 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eug_d3: (text) =>
    `Write a Korean 장애 회고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 요약, 영향, 타임라인, 근본 원인, 재발 방지 책임(비난 없는 톤) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eug_d4: (text) =>
    `Write a Korean 뉴스레터 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 제목, 인트로, 주요 소식 3개, 팁/링크, 마무리 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_eug_d5: (text) =>
    `Write a Korean 면접 평가표. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지원자/포지션, 평가 역량(4-6개, 척도 포함), 인터뷰 노트, 종합 추천 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_euv_l1: (text) =>
    `Translate the following Korean text into Occitan (Romance, southern France). Use authentic, natural Occitan as a fluent speaker would write it. Provide the Occitan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_euv_l2: (text) =>
    `Translate the following Korean text into Breton (Celtic, Brittany). Use authentic, natural Breton as a fluent speaker would write it. Provide the Breton translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_euv_l3: (text) =>
    `Translate the following Korean text into Cornish (Celtic, Cornwall). Use authentic, natural Cornish as a fluent speaker would write it. Provide the Cornish translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_euv_l4: (text) =>
    `Translate the following Korean text into Manx (Celtic, Isle of Man). Use authentic, natural Manx as a fluent speaker would write it. Provide the Manx translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_euv_l5: (text) =>
    `Translate the following Korean text into Galician (Romance, NW Spain). Use authentic, natural Galician as a fluent speaker would write it. Provide the Galician translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_euv_d1: (text) =>
    `Write a Korean 기획 제안서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목적/배경, 핵심 제안, 기대 효과, 일정, 리소스, 리스크 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_euv_d2: (text) =>
    `Write a Korean 주간 업무 보고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 지난주 성과, 이번주 계획, 이슈/블로커, 도움 요청 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_euv_d3: (text) =>
    `Write a Korean 회의록. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 일시/참석자, 안건, 논의 요점, 결정 사항, Action Item(담당/기한) 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_euv_d4: (text) =>
    `Write a Korean 제품 요구사항 문서(PRD). 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 문제 정의, 목표, 사용자 시나리오, 기능 요구, 비기능 요구, 성공 지표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_euv_d5: (text) =>
    `Write a Korean 고객 응대 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 공감 멘트, 해결 안내, 대안 제시, 마무리 인사 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_evk_l1: (text) =>
    `Translate the following Korean text into Asturian (Romance, Asturias). Use authentic, natural Asturian as a fluent speaker would write it. Provide the Asturian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_evk_l2: (text) =>
    `Translate the following Korean text into Aromanian (Eastern Romance, Balkans). Use authentic, natural Aromanian as a fluent speaker would write it. Provide the Aromanian translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_evk_l3: (text) =>
    `Translate the following Korean text into Ladino (Judeo-Spanish). Use authentic, natural Ladino as a fluent speaker would write it. Provide the Ladino translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_evk_l4: (text) =>
    `Translate the following Korean text into Tatar (Turkic, Volga). Use authentic, natural Tatar as a fluent speaker would write it. Provide the Tatar translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_evk_l5: (text) =>
    `Translate the following Korean text into Bashkir (Turkic, Urals). Use authentic, natural Bashkir as a fluent speaker would write it. Provide the Bashkir translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_evk_d1: (text) =>
    `Write a Korean 배포 노트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 이번 배포 하이라이트, 새 기능, 개선 사항, 버그 수정, 알림 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_evk_d2: (text) =>
    `Write a Korean 채용 공고. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 포지션 소개, 주요 업무, 자격 요건, 우대 사항, 복리후생, 지원 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_evk_d3: (text) =>
    `Write a Korean 영업 제안 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 인사, 고객 과제 공감, 제안 가치, 다음 단계(CTA) 구성으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_evk_d4: (text) =>
    `Write a Korean 온보딩 가이드. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 환영 메시지, 첫주 할 일 체크리스트, 주요 도구, 도움을 받을 곳 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_evk_d5: (text) =>
    `Write a Korean 성과 평가 자기서술. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 핵심 성과, 기여도, 성장 영역, 다음 분기 목표 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  translate_evz_l1: (text) =>
    `Translate the following Korean text into Chuvash (Turkic, Volga). Use authentic, natural Chuvash as a fluent speaker would write it. Provide the Chuvash translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_evz_l2: (text) =>
    `Translate the following Korean text into Tuvan (Turkic, Siberia). Use authentic, natural Tuvan as a fluent speaker would write it. Provide the Tuvan translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_evz_l3: (text) =>
    `Translate the following Korean text into Buryat (Mongolic, Lake Baikal). Use authentic, natural Buryat as a fluent speaker would write it. Provide the Buryat translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_evz_l4: (text) =>
    `Translate the following Korean text into Kalmyk (Mongolic, Caspian steppe). Use authentic, natural Kalmyk as a fluent speaker would write it. Provide the Kalmyk translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  translate_evz_l5: (text) =>
    `Translate the following Korean text into Udmurt (Uralic, Volga). Use authentic, natural Udmurt as a fluent speaker would write it. Provide the Udmurt translation, then a romanized pronunciation line if the script is non-Latin, then a 1-line Korean note on any term you had to adapt. Output only the translation block.\n\nKorean text:\n${text}`,
  doc_evz_d1: (text) =>
    `Write a Korean OKR 초안. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 분기 목표(Objective), 핵심 결과(Key Results 3개), 이니셔티브, 측정 방법 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_evz_d2: (text) =>
    `Write a Korean 기술 설계 문서. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 배경, 목표와 비목표, 제안 아키텍처, 대안 비교, 트레이드오프, 롤아웃 계획 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_evz_d3: (text) =>
    `Write a Korean 사용자 인터뷰 스크립트. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 목표, 도입 질문, 핵심 질문(경험/행동 기반), 마무리 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_evz_d4: (text) =>
    `Write a Korean 경쟁사 분석. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 비교 대상, 평가 축, 강점/약점 표, 시사점, 대응 전략 섹션으로. 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
  doc_evz_d5: (text) =>
    `Write a Korean 에스컬레이션 메일. 해요체로 자연스럽게, 실무에서 바로 쓸 수 있게. 다음 구조로 Markdown 작성: 상황 요약, 영향도, 요청 사항, 기한, 필요 지원 구성으로 (차분하고 명확하게). 입력에 있는 사실만 사용하고, 모르는 값은 '확인 필요'로 표기.\n\n입력:\n${text}`,
};

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "unauth" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | {
        action?: string;
        text?: string;
        question?: string;
        workspaceSlug?: string;
        instruction?: string;
      }
    | null;
  if (!body || !body.action) {
    return NextResponse.json({ error: "missing action" }, { status: 400 });
  }
  const userId = (session.user as { id: string }).id;

  // "ask" mode: free-form Q&A about a page. body.text is page content, body.question is the user prompt.
  let userMessage: string | null = null;
  let sources: { id: string; title: string }[] = [];
  if (body.action === "ask") {
    const question = (body.question ?? "").trim();
    if (!question) {
      return NextResponse.json({ error: "missing question" }, { status: 400 });
    }
    const context = (body.text ?? "").slice(0, 6000);
    userMessage = context
      ? `Page content:\n"""\n${context}\n"""\n\nQuestion: ${question}`
      : `Question: ${question}`;
  } else if (body.action === "askWorkspace") {
    const question = (body.question ?? "").trim();
    if (!question) {
      return NextResponse.json({ error: "missing question" }, { status: 400 });
    }
    if (!body.workspaceSlug) {
      return NextResponse.json({ error: "missing workspace" }, { status: 400 });
    }
    const ctx = await buildWorkspaceContext(
      body.workspaceSlug,
      userId,
      question,
    );
    if (!ctx) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    sources = ctx.sources;
    userMessage = ctx.context
      ? `Workspace pages:\n"""${ctx.context}\n"""\n\nQuestion: ${question}\n\nAnswer using the pages above. If unsure, say so.`
      : `Question: ${question}\n\n(No related pages found in this workspace.)`;
  } else {
    const promptFn = ACTION_PROMPT[body.action];
    if (!promptFn) {
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    if (!body.text) {
      return NextResponse.json({ error: "missing text" }, { status: 400 });
    }
    userMessage = promptFn(
      body.text,
      (body as { instruction?: string }).instruction,
    );
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return NextResponse.json({
      configured: false,
      output:
        `[AI placeholder — ${body.action}]\n\nSet OPENAI_API_KEY in apps/web/.env.local to enable real completions.`,
      sources,
    });
  }
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userMessage },
        ],
        max_tokens: body.action === "ask" ? 600 : 400,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      return NextResponse.json({ configured: true, error: t.slice(0, 200) }, { status: 502 });
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const output = data.choices?.[0]?.message?.content?.trim() ?? "";
    return NextResponse.json({ configured: true, output, sources });
  } catch (e) {
    return NextResponse.json(
      { configured: true, error: (e as Error).message },
      { status: 502 },
    );
  }
}
