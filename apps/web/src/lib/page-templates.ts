export type PageTemplate = {
  id: string;
  name: string;
  icon: string;
  title: string;
  content: unknown[];
};

const text = (s: string) => [{ type: "text", text: s, styles: {} }];

export const PAGE_TEMPLATES: PageTemplate[] = [
  {
    id: "meeting",
    name: "Meeting notes",
    icon: "📝",
    title: "Meeting notes",
    content: [
      { type: "heading", props: { level: 1 }, content: text("Meeting notes") },
      { type: "paragraph", content: text("Date: ") },
      { type: "paragraph", content: text("Attendees: ") },
      { type: "heading", props: { level: 2 }, content: text("Agenda") },
      { type: "bulletListItem", content: text("") },
      { type: "heading", props: { level: 2 }, content: text("Discussion") },
      { type: "paragraph", content: text("") },
      { type: "heading", props: { level: 2 }, content: text("Action items") },
      { type: "checkListItem", props: { checked: false }, content: text("") },
    ],
  },
  {
    id: "project",
    name: "Project brief",
    icon: "🚀",
    title: "Project brief",
    content: [
      { type: "heading", props: { level: 1 }, content: text("Project brief") },
      { type: "callout", props: { emoji: "🎯", color: "yellow" }, content: text("Goal of this project") },
      { type: "heading", props: { level: 2 }, content: text("Context") },
      { type: "paragraph", content: text("") },
      { type: "heading", props: { level: 2 }, content: text("Scope") },
      { type: "bulletListItem", content: text("In scope: ") },
      { type: "bulletListItem", content: text("Out of scope: ") },
      { type: "heading", props: { level: 2 }, content: text("Milestones") },
      { type: "checkListItem", props: { checked: false }, content: text("") },
      { type: "heading", props: { level: 2 }, content: text("Owners") },
      { type: "paragraph", content: text("") },
    ],
  },
  {
    id: "reading",
    name: "Reading list",
    icon: "📚",
    title: "Reading list",
    content: [
      { type: "heading", props: { level: 1 }, content: text("Reading list") },
      { type: "paragraph", content: text("Books, articles, papers I want to read.") },
      { type: "heading", props: { level: 2 }, content: text("Now reading") },
      { type: "bulletListItem", content: text("") },
      { type: "heading", props: { level: 2 }, content: text("To read") },
      { type: "bulletListItem", content: text("") },
      { type: "heading", props: { level: 2 }, content: text("Done") },
      { type: "bulletListItem", content: text("") },
    ],
  },
  {
    id: "todo",
    name: "Daily to-do",
    icon: "✅",
    title: "Daily to-do",
    content: [
      { type: "heading", props: { level: 1 }, content: text("Today") },
      { type: "checkListItem", props: { checked: false }, content: text("") },
      { type: "checkListItem", props: { checked: false }, content: text("") },
      { type: "checkListItem", props: { checked: false }, content: text("") },
      { type: "heading", props: { level: 2 }, content: text("Notes") },
      { type: "paragraph", content: text("") },
    ],
  },
];
