import { NextResponse, type NextRequest } from "next/server";

// UX only: send visitors without a session cookie to sign-in. The API is the enforcement point
// (it rejects any request without a valid token), so a forged cookie gains nothing.
export function proxy(request: NextRequest) {
  if (!request.cookies.has("sentra_session")) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }
}

export const config = {
  matcher: ["/((?!auth/|_next/|favicon.ico).*)"],
};
