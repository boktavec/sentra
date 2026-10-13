import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Plain POST form, so signing out works without JavaScript. The label hides below `sm`. */
export function SignOutButton() {
  return (
    <form action="/auth/logout" method="post">
      <Button type="submit" variant="ghost" size="sm">
        <LogOut aria-hidden />
        <span className="sr-only sm:not-sr-only">Sign out</span>
      </Button>
    </form>
  );
}
