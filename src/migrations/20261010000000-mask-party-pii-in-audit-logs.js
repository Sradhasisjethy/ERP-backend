'use strict';

/**
 * Masks party identity and bank details already sitting in audit_logs.
 *
 * Party audit rows were written with the whole record (create/delete) or the
 * changed fields (update), so every Aadhaar, PAN, bank account and date of
 * birth ever entered is readable by anyone with AUDIT_READ. Party now lists
 * these in `auditExclude`, so new rows no longer carry them; this cleans up the
 * old ones.
 *
 * Masked, not deleted: the row must still show that the field changed and
 * when, and the last four characters are what an auditor uses to tell two
 * values apart. Same format as partySensitive.js#maskValue — eight bullets
 * plus the last four, the whole value hidden for a date of birth or anything
 * four characters or shorter. A value already containing the bullet is left
 * alone, so running this twice is harmless.
 *
 * The field list is copied rather than required from the model on purpose: a
 * migration must keep meaning what it meant when it was written.
 */
const SENSITIVE_FIELDS = [
  'aadhaarNumber',
  'pan',
  'bankAccountNumber',
  'bankIfsc',
  'beneficiaryName',
  'esicNumber',
  'esicIpNumber',
  'uanNumber',
  'dateOfBirth',
  'emergencyContactName',
  'emergencyContactPhone',
];
const HIDE_WHOLE = ['dateOfBirth'];
const SNAPSHOT_COLUMNS = ['beforeSnapshot', 'afterSnapshot'];

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('audit_logs')) return;

    for (const column of SNAPSHOT_COLUMNS) {
      for (const field of SENSITIVE_FIELDS) {
        // chr(8226) is '•'. jsonb_typeof filters out SQL NULL snapshots, JSON
        // null values and non-object snapshots in one go.
        const masked = HIDE_WHOLE.includes(field)
          ? 'repeat(chr(8226), 8)'
          : `CASE WHEN length("${column}"->>:field) <= 4 THEN repeat(chr(8226), 8)
                  ELSE repeat(chr(8226), 8) || right("${column}"->>:field, 4) END`;

        await sequelize.query(
          `UPDATE audit_logs
              SET "${column}" = jsonb_set("${column}", ARRAY[:field]::text[], to_jsonb(${masked}))
            WHERE "entityType" = 'Party'
              AND jsonb_typeof("${column}") = 'object'
              AND jsonb_typeof("${column}"->:field) IN ('string', 'number')
              AND "${column}"->>:field <> ''
              AND position(chr(8226) in "${column}"->>:field) = 0`,
          { replacements: { field } }
        );
      }
    }
  },

  async down() {
    // Irreversible by design: the point is that the full values no longer exist.
  },
};
