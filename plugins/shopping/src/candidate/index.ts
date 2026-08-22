/**
 * candidate 模块出口（冻结基础设施）。
 */

export {
  CANDIDATE_ID_PATTERN,
  EDITABLE_SURFACES,
  MAX_EDIT_CONTENT_CHARS,
  MAX_HYPOTHESIS_CHARS,
  MAX_PROPOSAL_EDITS,
  PROPOSAL_SCHEMA_VERSION,
  ProposalError,
  assertSafeCandidateId,
  parseProposal,
  type Proposal,
  type ProposalEdit,
} from "./schema.ts";

export {
  MaterializeError,
  materializeCandidate,
  type MaterializeOptions,
  type MaterializedCandidate,
} from "./materialize.ts";
