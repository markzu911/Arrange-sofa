import type { PlacementCandidate, TrialPlacementPlan } from "../types";

/**
 * The model proposes candidates, while this deterministic gate rejects layouts
 * that contradict hard spatial rules before the image model sees them.
 */
export function resolvePlacementPlan(plan: TrialPlacementPlan): TrialPlacementPlan {
  const ranked = plan.candidates
    .filter((candidate) => !candidate.blocksWalkway)
    .filter((candidate) => !candidate.conflictsWithPreservedItems)
    .filter((candidate) => !candidate.violatesUserRequirements)
    .sort((left, right) => right.score - left.score);

  const selected = ranked[0] || [...plan.candidates].sort((left, right) => right.score - left.score)[0];
  if (!selected) return plan;

  const rejectedCount = plan.candidates.length - ranked.length;
  return {
    ...plan,
    selectedCandidateId: selected.id,
    placement: selected.placement,
    facing: selected.facing,
    scale: selected.scale,
    summary: `${plan.summary} 已自动采用“${selected.label}”方案${rejectedCount ? `，并排除了 ${rejectedCount} 个与通道、保留家具或用户要求冲突的候选位。` : "。"}`,
    rationale: [...selected.reasons, ...plan.rationale.filter((item) => !selected.reasons.includes(item))]
  };
}

export function selectedCandidate(plan: TrialPlacementPlan): PlacementCandidate | undefined {
  return plan.candidates.find((candidate) => candidate.id === plan.selectedCandidateId);
}
