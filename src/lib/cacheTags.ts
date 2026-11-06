// Every server-cached read of contest data carries this tag, and every write
// to contest data invalidates it (lib/revalidateContest.ts).
export const CONTEST_TAG = 'contest'
