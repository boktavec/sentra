import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CenteredLayout } from "@/components/shell/centered-layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NewOrgForm } from "./new-org-form";

export default function NewOrgPage() {
  return (
    <CenteredLayout>
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden className="size-4" />
        All organizations
      </Link>
      <Card>
        <CardHeader>
          <CardTitle role="heading" aria-level={1} className="text-xl">
            Create organization
          </CardTitle>
        </CardHeader>
        <CardContent>
          <NewOrgForm />
        </CardContent>
      </Card>
    </CenteredLayout>
  );
}
