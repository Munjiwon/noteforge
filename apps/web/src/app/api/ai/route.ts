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
