# Personal data breach: response runbook

A personal data breach is any unauthorised processing, accidental disclosure, use, alteration or destruction of personal data, or loss of access to it, that compromises its confidentiality, integrity or availability (Act s.2(u)). Some examples:

- a lost or stolen laptop or phone holding the wage sheet;
- a wage sheet or customer list emailed to the wrong person;
- a leaked database password, even if nobody is known to have used it;
- ransomware on the server;
- an employee copying customer data before leaving;
- a misconfigured file link that anyone could open.

**There is no threshold.** Every breach goes to the Board and to the people affected. The clock starts when the business **becomes aware**, not when it finishes investigating.

## Hour 0: as soon as you know

1. Record it in **Data Protection > Breaches > Record a breach**. Enter the time you became aware, even if you know very little yet. This starts the 72-hour clock, and a CRITICAL alert fires if a deadline gets close.
2. Tell the privacy contact and the owner.
3. **Contain it.** Depending on the breach:
   - revoke the leaked credential;
   - sign out all sessions;
   - disable the account;
   - recall the email;
   - take the server offline;
   - change shared passwords.

   Record the containment as a step.
4. Preserve evidence. Keep logs and do not wipe the affected machine. The audit trail (Audit & Activity) shows who changed what and from where.

## Within hours: tell the Board (intimation)

Rule 7(2)(a) requires a first intimation to the Board **without delay**. It describes the breach, its nature, extent, timing and location, and its likely impact.

5. Open the breach. Copy the **Report to the Data Protection Board** draft, complete it with what you know, and submit it through the Board's portal.
6. Mark **Board intimated**.

## Without delay: tell the people affected

Rule 7(1) requires telling each affected person, through their account or their registered contact details. The notice must say:

- what happened (nature, extent, timing, location);
- the likely consequences for them;
- what you have done and are doing;
- what they can do to protect themselves;
- whom to contact.

7. Fill in **What the people affected can do** on the breach. Copy the **Notice to the people affected** draft and send it by SMS, email, letter, or in person for labour. Keep a list of who was told and how.
8. Mark **People affected told**, with the method.

## Within 72 hours: the detailed report

Rule 7(2)(b) requires a report within 72 hours of becoming aware. The Board may extend this if you ask in writing. The report covers:

- the broad facts, events, circumstances and reasons;
- the mitigation measures taken or proposed;
- any findings about the person who caused it;
- the measures to prevent it happening again;
- a report on the intimations sent to affected people.

9. Update the breach with the cause, the likely consequences and the mitigation. The draft report rebuilds from the register.
10. Submit it, then mark **Detailed report sent to the Board** with the Board's reference.

## Afterwards

11. Fix the root cause. Add what you learned to the breach's mitigation field.
12. When everything is done, **Close the breach**. The system refuses to close it until containment, the Board intimation, the report and the notice to affected people are all recorded.

## Who does what

| Role | Responsibility |
|---|---|
| Whoever discovers it | Records it at once, even incompletely. Tells the privacy contact. |
| Application owner (Data Protection desk) | Owns the breach record, the Board submissions and the notices to people, for every organisation |
| Owner / management | Approves the notices and decides on containment that stops the business |
| IT / developer | Containment, evidence, root cause |

Penalty for failing to give notice of a breach: up to ₹200 crore. Penalty for failing to take reasonable security safeguards: up to ₹250 crore.
