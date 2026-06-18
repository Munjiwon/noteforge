import { redirect } from "next/navigation";

export default function WorkProjectIndex({
  params,
}: {
  params: { slug: string; key: string };
}) {
  redirect(`/w/${params.slug}/work/${params.key}/board`);
}
