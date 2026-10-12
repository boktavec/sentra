import Link from "next/link";
import { CenteredLayout } from "@/components/shell/centered-layout";
import { NewOrgForm } from "./new-org-form";

export default function NewOrgPage() {
  return (
    <CenteredLayout>
      <main>
        <p>
          <Link href="/">All organizations</Link>
        </p>
        <h1>Create organization</h1>
        <NewOrgForm />
      </main>
    </CenteredLayout>
  );
}
