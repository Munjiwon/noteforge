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
