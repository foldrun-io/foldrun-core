// The records contract against the in-memory reference port.
//   node --test tests/records-contract-fake.test.ts
import { recordsContract } from "./records-contract.ts";
import { fakeRecords } from "./fake-records.ts";

recordsContract("fake", async () => ({ port: fakeRecords(), done() {} }));
