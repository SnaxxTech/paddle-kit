import {
  MAX_WEBHOOK_BODY_BYTES,
  PaddleTransportError,
  createBilling,
  createPaddleTransport
} from "../chunk-65TXCZB7.js";
import "../chunk-UYGU5JF5.js";
import "../chunk-LCG6MQ62.js";
import "../chunk-74Z3S4IU.js";

// src/core/adjustments.ts
function adjustmentEffect(adj) {
  if (adj.status === "pending_approval" || adj.status === "rejected") return "none";
  if (adj.status === "reversed") return adj.action === "refund" || adj.action === "chargeback" ? "restore" : "none";
  if (adj.status !== "approved") return "review";
  switch (adj.action) {
    case "refund":
      return adj.type === "full" ? "revoke" : "review";
    case "chargeback":
      return "revoke";
    case "chargeback_reverse":
      return "restore";
    case "chargeback_warning":
      return "review";
    case "chargeback_warning_reverse":
    case "credit":
    case "credit_reverse":
      return "none";
    default:
      return "review";
  }
}
function paymentRevoked(adjustments) {
  const approved = adjustments.filter((a) => a.status === "approved");
  const count = (action) => approved.filter((a) => a.action === action).length;
  return approved.some((a) => a.action === "refund" && a.type === "full") || count("chargeback") > count("chargeback_reverse");
}
export {
  MAX_WEBHOOK_BODY_BYTES,
  PaddleTransportError,
  adjustmentEffect,
  createBilling,
  createPaddleTransport,
  paymentRevoked
};
