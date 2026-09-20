import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, escapeIlike } from '@/lib/api'
import { hashPassword, passwordValidationError } from '@/lib/password'
import { logAudit } from '@/lib/audit'

// bcrypt cost-12 hashing is intentionally serial per row. Allow enough runtime
// that a full-size batch cannot be killed halfway through credential creation.
export const maxDuration = 300
const MAX_ROWS = 100

interface CSVRow {
  full_name: string
  phone: string
  email: string
  venmo_handle: string
  paid: boolean
  password: string
}

function parseCSV(csv: string): CSVRow[] {
  const lines = csv.trim().split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return []

  // Skip header row
  const rows = lines.slice(1)
  return rows.map((line) => {
    // Simple CSV parse (handles unquoted fields)
    const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    const [full_name = '', phone = '', email = '', venmo_handle = '', paidStr = '', password = ''] = cols
    const paid =
      paidStr.toLowerCase() === 'yes' ||
      paidStr.toLowerCase() === 'true' ||
      paidStr === '1'
    return { full_name, phone, email: email.toLowerCase(), venmo_handle, paid, password }
  }).filter((r) => r.full_name && r.email && r.password)
}

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const { csv } = await req.json()
    if (!csv) return NextResponse.json({ error: 'No CSV provided' }, { status: 400 })

    const rows = parseCSV(csv)
    if (rows.length === 0) {
      return NextResponse.json({ error: 'No valid rows found. Check CSV format.' }, { status: 400 })
    }
    if (rows.length > MAX_ROWS) {
      return NextResponse.json(
        { error: `Too many rows (${rows.length} > ${MAX_ROWS}). Split the CSV into smaller batches.` },
        { status: 400 }
      )
    }

    const supabase = await getDb()

    let count = 0
    let skipped = 0
    const errors: string[] = []

    for (const row of rows) {
      try {
        const passwordError = passwordValidationError(row.password)
        if (passwordError) {
          errors.push(`${row.full_name}: ${passwordError}`)
          continue
        }

        // Check if player already exists — never overwrite their password.
        const { data: existing } = await supabase
          .from('players')
          .select('id')
          .ilike('email', escapeIlike(row.email))
          .single()

        if (existing) {
          skipped++
          continue
        }

        const pin_hash = await hashPassword(row.password)

        const { error } = await supabase.from('players').insert({
          full_name: row.full_name,
          phone: row.phone || null,
          email: row.email,
          venmo_handle: row.venmo_handle || null,
          paid: row.paid,
          status: 'alive',
          pin_hash,
        })

        if (error) {
          errors.push(`${row.full_name}: ${error.message}`)
          continue
        }

        count++
      } catch {
        errors.push(`${row.full_name}: unexpected error`)
      }
    }

    await logAudit(supabase, {
      event_type: 'players-imported',
      actor: 'admin',
      message: `Admin imported ${count} player${count === 1 ? '' : 's'} from CSV${skipped > 0 ? ` (${skipped} already existed)` : ''}`,
      details: { created: count, skipped, errors },
    })

    return NextResponse.json({
      ok: true,
      count,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (err) {
    console.error('import error', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
