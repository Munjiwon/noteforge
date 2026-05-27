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
