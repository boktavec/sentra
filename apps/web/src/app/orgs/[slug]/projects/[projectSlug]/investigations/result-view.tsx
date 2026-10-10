import Link from "next/link";
import { explainPriority, kevLabel, priorityLabel } from "@/lib/finding-format";
import {
  evidenceLinks,
  GAP_TEXT,
  type InvestigationResult,
  type ResultFacts,
} from "@/lib/investigation-result";

function SeverityValue({ advisory }: { advisory: ResultFacts["advisory"] }) {
  if (advisory.cvssScore === null) return "Severity unavailable";
  return `CVSS ${advisory.cvssScore.toFixed(1)}${advisory.cvssVersion ? ` (v${advisory.cvssVersion})` : ""}`;
}

function PriorityValue({ priority }: { priority: ResultFacts["priority"] }) {
  if (!priority) return "Not checked";
  return (
    <>
      <strong>{priorityLabel(priority)}</strong>
      <ul>
        {explainPriority(priority).map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </>
  );
}

function Facts({ facts }: { facts: ResultFacts }) {
  const { advisory } = facts;
  return (
    <section aria-labelledby="result-facts" data-testid="result-facts">
      <h3 id="result-facts">From your project and security data</h3>
      <dl>
        <dt>Dependency</dt>
        <dd>{facts.purl}</dd>
        <dt>Scope and match</dt>
        <dd>{[facts.scope, facts.matchQuality, facts.status].filter(Boolean).join(" · ")}</dd>
        <dt>Advisory</dt>
        <dd>{[advisory.sourceId, ...advisory.aliases].join(", ")}</dd>
        <dt>Severity</dt>
        <dd>
          <SeverityValue advisory={advisory} />
        </dd>
        <dt>Exploitation data</dt>
        <dd>{facts.kevStatus ? kevLabel(facts.kevStatus) : "Not checked"}</dd>
        <dt>Sentra priority</dt>
        <dd data-testid="result-priority">
          <PriorityValue priority={facts.priority} />
        </dd>
      </dl>
      {facts.source === "snapshot" && (
        <p>These values come from the finding as it was when the run started.</p>
      )}
    </section>
  );
}

function Explanation({
  result,
  findingBase,
}: {
  result: InvestigationResult["result"];
  findingBase: string;
}) {
  return (
    <section aria-labelledby="result-explanation" data-testid="result-explanation">
      <h3 id="result-explanation">AI-generated explanation</h3>
      <p>The model wrote this text. Check each statement against the evidence listed under it.</p>
      <h4>Summary</h4>
      <p>{result.summary}</p>
      <h4>Impact on this project</h4>
      <p>{result.tenantImpact}</p>
      <h4>Statements and evidence</h4>
      <ul data-testid="result-claims">
        {result.claims.map((claim, index) => (
          <li key={index}>
            {claim.text}
            <ul>
              {evidenceLinks(result, claim.evidence).map((link, linkIndex) => (
                <li key={linkIndex}>
                  {link.findingId ? (
                    <Link href={`${findingBase}/${encodeURIComponent(link.findingId)}`}>
                      {link.label}
                    </Link>
                  ) : (
                    link.label
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {result.nextSteps.length > 0 && (
        <>
          <h4>Suggested next steps</h4>
          <ul>
            {result.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Gaps({ result }: { result: InvestigationResult["result"] }) {
  return (
    <section aria-labelledby="result-gaps" data-testid="result-gaps">
      <h3 id="result-gaps">Known gaps and uncertainty</h3>
      {result.gaps.length === 0 ? (
        <p>No data gaps were detected.</p>
      ) : (
        <ul>
          {result.gaps.map((gap) => (
            <li key={gap}>{GAP_TEXT[gap]}</li>
          ))}
        </ul>
      )}
      <h4>The model is unsure about</h4>
      {result.uncertainties.length > 0 ? (
        <ul>
          {result.uncertainties.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      ) : (
        <p>The model reported no uncertainty: {result.noUncertaintyReason}</p>
      )}
    </section>
  );
}

/** The validated result of one run: retrieved facts, the model's explanation, then what is missing. */
export function ResultView({
  data,
  findingBase,
}: {
  data: InvestigationResult;
  /** `/orgs/<slug>/projects/<project>/findings`, the prefix of finding detail pages. */
  findingBase: string;
}) {
  const { result } = data;
  return (
    <article data-testid="investigation-result">
      <Facts facts={result.facts} />
      <Explanation result={result} findingBase={findingBase} />
      <Gaps result={result} />
      <p>
        Generated {new Date(result.generatedAt).toLocaleString()} by {result.modelId}. The API
        checked that every statement cites a tool result from this run before saving it.
      </p>
    </article>
  );
}
