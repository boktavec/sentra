import { NextResponse, type NextRequest } from "next/server";
import { RETURN_COOKIE } from "@/lib/return-to";

// UX only: send visitors without a session cookie to sign-in. The API is the enforcement point
// (it rejects any request without a valid token), so a forged cookie gains nothing.
export function proxy(request: NextRequest) {
  if (request.cookies.has("sentra_session")) return;
  const response = NextResponse.redirect(new URL("/auth/login", request.url));
  // Remember where the visitor was going; the callback validates the path before using it.
  response.cookies.set(RETURN_COOKIE, request.nextUrl.pathname + request.nextUrl.search, {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 600,
  });
  return response;
}

export const config = {
  matcher: ["/((?!auth/|_next/|favicon.ico).*)"],
};
