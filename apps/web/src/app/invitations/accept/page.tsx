import Link from "next/link";
import { AcceptForm } from "./accept-form";

export const dynamic = "force-dynamic";

// Accepting is a button (a POST), not this page load, so link previews and scanners cannot use up
// an invitation. The proxy has already sent signed-out visitors through sign-in and back here.
export default async function AcceptPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <main>
      <h1>Join an organization</h1>
      {token ? (
        <>
          <p>You have been invited to join an organization on Sentra.</p>
          <AcceptForm token={token} />
        </>
      ) : (
        <p data-testid="accept-error">This invitation link is not valid.</p>
      )}
      <p>
        <Link href="/">Home</Link>
      </p>
    </main>
  );
}
