// web/src/lib/mockData.js
//
// The enquiry-tracking backend (enquiries / enquiry_stage_history tables —
// see schema.sql) is designed and specified but not yet built (that's
// Phase 6 in the roadmap). This file stands in for GET /enquiries until
// then. Replace mockEnquiryLog() with a real api.getEnquiries() call once
// that endpoint exists — nothing else in AdminDashboard.jsx should need to
// change, since it already consumes this as if it were an API response.

export function mockEnquiryLog() {
  const now = Date.now();
  const hours = (n) => new Date(now - n * 3600 * 1000).toISOString();
  return [
    { id: 'ENQ-1042', company: 'Reliance Refinery', product_hint: 'Smart pressure transmitter, HART, ATEX', stage: 'offer_sent', assigned_to: 'S. Rao', received_at: hours(2) },
    { id: 'ENQ-1041', company: 'Tata Steel', product_hint: 'Level switch, top mounted, 2m tank', stage: 'matched', assigned_to: 'A. Iyer', received_at: hours(5) },
    { id: 'ENQ-1040', company: 'ITC Foods', product_hint: 'Hygienic pressure transmitter, tri-clamp', stage: 'reviewed', assigned_to: 'S. Rao', received_at: hours(9) },
    { id: 'ENQ-1039', company: 'NTPC', product_hint: 'Differential pressure switch, filter monitoring', stage: 'new', assigned_to: null, received_at: hours(14) },
    { id: 'ENQ-1038', company: 'Aditya Birla Chemicals', product_hint: 'Temperature transmitter, universal input', stage: 'won', assigned_to: 'A. Iyer', received_at: hours(30) },
    { id: 'ENQ-1037', company: 'JSW Cement', product_hint: 'Weatherproof pressure switch', stage: 'lost', assigned_to: 'S. Rao', received_at: hours(48) },
  ];
}

export const STAGE_LABELS = {
  new: 'New',
  extracted: 'Extracted',
  reviewed: 'Reviewed',
  matched: 'Matched',
  offer_drafted: 'Offer Drafted',
  offer_sent: 'Offer Sent',
  won: 'Won',
  lost: 'Lost',
};
