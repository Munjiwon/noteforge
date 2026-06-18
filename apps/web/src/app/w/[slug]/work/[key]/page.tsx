import { redirect } from "next/navigation";

export default function WorkProjectIndex({
  params,
}: {
  params: { slug: string; key: string };
}) {
  // Board view is added in a later step; land on the issues list for now.
  redirect(`/w/${params.slug}/work/${params.key}/issues`);
}
