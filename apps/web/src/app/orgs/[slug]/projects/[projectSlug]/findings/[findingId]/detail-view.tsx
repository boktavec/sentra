import Link from "next/link";
import {
  explainEvidence,
  explainPriority,
  formatDate,
  kevLabel,
  optionLabel,
  priorityLabel,
  resolvedReasonLabel,
  safeHref,
  severityLabel,
} from "@/lib/finding-format";
import type { FindingDetail, FindingMember, KevEntry } from "@/lib/findings";

const DETAILS_PREVIEW_CHARS = 1000;

const card = {
  border: "1px solid #d1d5db",
  borderRadius: 8,
  padding: "1rem",
  marginBottom: "1rem",
};
const grid = {
  display: "grid",
  gridTemplateColumns: "max-content minmax(0, 1fr)",
  gap: "0.5rem 1rem",
  marginBottom: 0,
};
const value = { margin: 0, overflowWrap: "anywhere" as const };
const textBlock = { whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const };

function Facts({ facts }: { facts: { label: string; value: string }[] }) {
  return (
    <dl style={grid}>
      {facts.map(({ label, value: text }) => (
        <div key={label} style={{ display: "contents" }}>
          <dt>{label}</dt>
          <dd style={value}>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

function Kev({ finding }: { finding: FindingDetail }) {
  return (
    <>
      <dt>Exploitation</dt>
      <dd style={value} data-testid="kev-status">
        {kevLabel(finding.kevStatus)}
        {finding.kev?.map((entry) => (
          <KevEntryDetails key={entry.cveId} entry={entry} />
        ))}
      </dd>
    </>
  );
}

function KevEntryDetails({ entry }: { entry: KevEntry }) {
  return (
    <Facts
      facts={[
        { label: "CVE", value: entry.cveId },
        { label: "Date added", value: entry.dateAdded },
        ...(entry.dueDate ? [{ label: "Due date", value: entry.dueDate }] : []),
        ...(entry.knownRansomwareUse
          ? [{ label: "Known ransomware use", value: entry.knownRansomwareUse }]
          : []),
        ...(entry.requiredAction
          ? [{ label: "Required action", value: entry.requiredAction }]
          : []),
        { label: "Catalog version", value: entry.catalogVersion },
      ]}
    />
  );
}

function RiskFactors({ finding }: { finding: FindingDetail }) {
  const { vulnerability: v } = finding;
  const lead = finding.members[0]!;
  return (
    <section aria-labelledby="risk-heading" style={card}>
      <h2 id="risk-heading">Risk factors</h2>
      <p data-testid="priority">
        <strong>Sentra priority {priorityLabel(finding.priority)}</strong>
      </p>
      <ul data-testid="priority-reasons">
        {explainPriority(finding.priority).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <dl style={grid}>
        <dt>CVSS</dt>
        <dd style={value}>
          {severityLabel(v)}
          {v.cvssSource && ` from ${v.cvssSource.source}: ${v.cvssSource.sourceId}`}
        </dd>
        <Kev finding={finding} />
        <dt>Match quality</dt>
        <dd style={value}>
          {optionLabel(lead.matchQuality)}
          {lead.matchReason && ` (${lead.matchReason.replaceAll("_", " ")})`}
        </dd>
        <dt>Dependency scope</dt>
        <dd style={value}>{optionLabel(finding.scope)}</dd>
      </dl>
    </section>
  );
}

function Evidence({ member }: { member: FindingMember }) {
  const explanation = explainEvidence(member.evidence, member.matchQuality, member.matchReason);
  return (
    <div>
      <h4>Why this is affected</h4>
      {explanation ? (
        <>
          <p>{explanation.summary}</p>
          <Facts facts={explanation.facts} />
        </>
      ) : (
        <p>Sentra could not summarize this evidence; the raw record is below.</p>
      )}
      <details>
        <summary>Raw matcher evidence (matcher version {member.matcherVersion})</summary>
        <pre style={textBlock}>{JSON.stringify(member.evidence, null, 2)}</pre>
      </details>
    </div>
  );
}

function DetailsText({ text }: { text: string }) {
  const long = text.length > DETAILS_PREVIEW_CHARS;
  return (
    <>
      <p style={textBlock}>{text.slice(0, DETAILS_PREVIEW_CHARS)}</p>
      {long && (
        <details>
          <summary>Show the rest of the details</summary>
          <p style={textBlock}>{text.slice(DETAILS_PREVIEW_CHARS)}</p>
        </details>
      )}
    </>
  );
}

function AdvisoryDetails({ advisory }: { advisory: FindingMember["advisory"] }) {
  if (!advisory.details) return null;
  return (
    <div>
      <DetailsText text={advisory.details} />
      {advisory.detailsTruncated && (
        <p data-testid="details-truncated">
          Details were cut at the size limit; see the source advisory for the rest.
        </p>
      )}
    </div>
  );
}

function Affected({ affected }: { affected: FindingMember["advisory"]["affected"] }) {
  if (affected.length === 0) return null;
  return (
    <div>
      <h4>Affected by this advisory</h4>
      <ul>
        {affected.map((entry, i) => (
          <li key={i}>
            <code>{entry.packageName}</code>
            {entry.versions.length > 0 && (
              <>
                {" "}
                versions {entry.versions.join(", ")}
                {entry.versionsTruncated && " (list cut at the size limit)"}
              </>
            )}
            {entry.ranges.map((range, i) => (
              <div key={i}>
                {range.type} range:{" "}
                {range.events.map((e) => `${e.type.replaceAll("_", " ")} ${e.version}`).join(", ")}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function References({ advisory }: { advisory: FindingMember["advisory"] }) {
  if (advisory.refs.length === 0) return null;
  return (
    <div>
      <h4>References</h4>
      <ul>
        {advisory.refs.map((ref, i) => {
          const href = safeHref(ref.url);
          const label = ref.type ? `${ref.type}: ` : "";
          return (
            <li key={i} style={{ overflowWrap: "anywhere" }}>
              {label}
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                  {href}
                </a>
              ) : (
                (ref.url ?? "(no URL)")
              )}
            </li>
          );
        })}
      </ul>
      {advisory.refsTruncated && (
        <p data-testid="refs-truncated">More references are not shown; see the source advisory.</p>
      )}
    </div>
  );
}

const optional = (label: string, text: string | null) => (text ? [{ label, value: text }] : []);

function isScoreSource(
  advisory: FindingMember["advisory"],
  source: FindingDetail["vulnerability"]["cvssSource"],
) {
  return source?.source === advisory.source && source.sourceId === advisory.sourceId;
}

function cvssText(advisory: FindingMember["advisory"], finding: FindingDetail) {
  if (advisory.cvssScore === null) return null;
  const score = `${advisory.cvssScore.toFixed(1)} (CVSS ${advisory.cvssVersion})`;
  return isScoreSource(advisory, finding.vulnerability.cvssSource)
    ? `${score}, used for the score above`
    : score;
}

function memberFacts(member: FindingMember, finding: FindingDetail) {
  const { advisory } = member;
  return [
    ...optional("Aliases", advisory.aliases.join(", ")),
    ...optional("Published", advisory.publishedAt && formatDate(advisory.publishedAt)),
    { label: "Modified", value: formatDate(advisory.modifiedAt) },
    ...optional("CVSS", cvssText(advisory, finding)),
    {
      label: "Finding",
      value: `${optionLabel(member.status)}, first seen ${formatDate(member.firstSeenAt)}`,
    },
  ];
}

function StatusNotes({ member }: { member: FindingMember }) {
  const { withdrawnAt } = member.advisory;
  return (
    <>
      {member.status === "resolved" && (
        <p data-testid="resolved-note">
          Resolved{member.resolvedAt && ` on ${formatDate(member.resolvedAt)}`}:{" "}
          {resolvedReasonLabel(member.resolvedReason)}.
        </p>
      )}
      {withdrawnAt && (
        <p data-testid="withdrawn-note">Withdrawn by source on {formatDate(withdrawnAt)}.</p>
      )}
    </>
  );
}

function Member({ member, finding }: { member: FindingMember; finding: FindingDetail }) {
  const { advisory } = member;
  return (
    <li data-testid="finding-member" style={card}>
      <h3 style={{ overflowWrap: "anywhere" }}>
        {advisory.source}: {advisory.sourceId}
      </h3>
      <Facts facts={memberFacts(member, finding)} />
      <StatusNotes member={member} />
      {advisory.summary && <p style={textBlock}>{advisory.summary}</p>}
      <AdvisoryDetails advisory={advisory} />
      <Evidence member={member} />
      <Affected affected={advisory.affected} />
      <References advisory={advisory} />
    </li>
  );
}

export function FindingDetailView({
  finding,
  base,
  projectName,
}: {
  finding: FindingDetail;
  base: string;
  projectName: string;
}) {
  const { vulnerability: v } = finding;
  const title = v.aliases.find((a) => a.startsWith("CVE-")) ?? v.sourceId;
  return (
    <main>
      <p>
        <Link href={base}>{projectName}</Link> /{" "}
        <Link href={`${base}/findings`}>Back to findings</Link>
      </p>
      <h1 style={{ overflowWrap: "anywhere" }}>{title}</h1>
      {v.summary && <p style={textBlock}>{v.summary}</p>}
      <dl style={grid}>
        <dt>Status</dt>
        <dd style={value} data-testid="finding-status">
          {optionLabel(finding.status)}
        </dd>
        <dt>Dependency</dt>
        <dd style={value}>
          <code>{finding.purl}</code>
        </dd>
        <dt>Version</dt>
        <dd style={value}>{finding.version}</dd>
        <dt>Ecosystem</dt>
        <dd style={value}>{finding.ecosystem}</dd>
        <dt>Scope</dt>
        <dd style={value}>{optionLabel(finding.scope)}</dd>
      </dl>
      <p>
        <Link href={`${base}/investigations`}>Investigate findings</Link>
      </p>
      <RiskFactors finding={finding} />
      <h2>Advisories and evidence</h2>
      <p>
        Source advisories that describe this issue for this dependency, with the evidence Sentra
        used to match each one.
      </p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {finding.members.map((member) => (
          <Member key={member.id} member={member} finding={finding} />
        ))}
      </ul>
      {finding.membersTruncated && (
        <p data-testid="members-truncated">
          More advisories for this issue are not shown; see the source advisories.
        </p>
      )}
    </main>
  );
}
