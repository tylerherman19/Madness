import 'server-only'
import { revalidatePath } from 'next/cache'
export function revalidateContest() {
  for (const path of ['/', '/standings', '/grid', '/live', '/pick', '/history', '/admin', '/admin/players']) revalidatePath(path)
}
