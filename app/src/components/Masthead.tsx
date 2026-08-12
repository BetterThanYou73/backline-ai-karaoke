import Link from "next/link";

export function Masthead({ tagline }: { tagline?: string }) {
  return (
    <header className="masthead">
      <div>
        <h1 className="wordmark">
          <Link href="/">
            Back<span>line</span>
          </Link>
        </h1>
        <p className="tagline">
          {tagline ?? "Sing, and the band follows you."}
        </p>
      </div>
    </header>
  );
}
