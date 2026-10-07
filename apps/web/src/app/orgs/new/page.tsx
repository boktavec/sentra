import Link from "next/link";
import { NewOrgForm } from "./new-org-form";

export default function NewOrgPage() {
  return (
    <main>
      <p>
        <Link href="/">All organizations</Link>
      </p>
      <h1>Create organization</h1>
      <NewOrgForm />
    </main>
  );
}
