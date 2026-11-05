/** Every side of a published comparison must remain approved and belong to its product. */
export const CHANGE_EVIDENCE_APPROVED = `e.product_id=c.product_id AND e.status='approved'
  AND (c.previous_evidence_id IS NULL OR EXISTS (
    SELECT 1 FROM evidence previous WHERE previous.id=c.previous_evidence_id
    AND previous.product_id=c.product_id AND previous.status='approved'))`;
