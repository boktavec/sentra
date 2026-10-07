import type { ReactNode } from "react";

export const metadata = { title: "Sentra" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: "2rem auto",
          maxWidth: 640,
          padding: "0 1rem",
        }}
      >
        {children}
      </body>
    </html>
  );
}
