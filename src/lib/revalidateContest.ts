import 'server-only'
import { revalidatePath } from 'next/cache'
export function revalidateContest() {
  for (const path of ['/', '/standings', '/grid', '/sweat', '/pick', '/admin', '/admin/players']) revalidatePath(path)
}
