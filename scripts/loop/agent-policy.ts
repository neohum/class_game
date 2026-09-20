// agent-policy.ts — who may review whom.
//
// One rule, and it is the one the loop's trustworthiness rests on: an agent may
// not sign off work it authored. "The same agent" means the same WEIGHTS, not
// the same process — two nodes serving one model are one opinion however many
// machines they run on, so independence is decided on a trust domain rather than
// on an agent name.
//
// Today every lane is a distinct provider and the domain is just the name. The
// indirection stays because the rule is about weights: the moment two lanes
// share a model, this is the single place that has to learn it.

/** The shape the loop passes around for a backlog card. */
export interface Card {
  card?: string;
  spec?: string;
  [key: string]: unknown;
}

export function trustDomainFor(agent: string | null | undefined): string {
  return String(agent || "").toLowerCase();
}

export function independentAgents(left: string, right: string): boolean {
  return trustDomainFor(left) !== trustDomainFor(right);
}
