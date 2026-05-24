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
