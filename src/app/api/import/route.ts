import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/testMode'
import { requireAdmin, escapeIlike, readJsonObject, badRequest } from '@/lib/api'
import { normalizeEmail, parseCsv } from '@/lib/validation'
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

type ParsedRow = { row: CSVRow } | { error: string }

// Header row first; quoted fields may contain commas (e.g. "Smith, Jr.").
function parseRows(csv: string): ParsedRow[] {
  return parseCsv(csv).slice(1).map((cols, index) => {
    const [rawName = '', phone = '', rawEmail = '', venmo_handle = '', paidStr = '', password = ''] = cols.map((c) => c.trim())
    const full_name = rawName.replace(/\s+/g, ' ')
    const line = `Row ${index + 2}`
    if (!full_name) return { error: `${line}: missing name` }
    if (full_name.length > 80) return { error: `${line}: name is longer than 80 characters` }
    const email = normalizeEmail(rawEmail)
    if (!email) return { error: `${line} (${full_name}): invalid email` }
    if (!password) return { error: `${line} (${full_name}): missing password` }
    const paid = ['yes', 'true', '1', 'y'].includes(paidStr.toLowerCase())
    return { row: { full_name, phone: phone.slice(0, 20), email, venmo_handle: venmo_handle.slice(0, 50), paid, password } }
  })
}

export async function POST(req: NextRequest) {
  const unauthorized = await requireAdmin()
  if (unauthorized) return unauthorized

  try {
    const body = await readJsonObject(req)
    const csv = body?.csv
    if (typeof csv !== 'string' || !csv.trim()) return badRequest('No CSV provided')
    if (csv.length > 200_000) return badRequest('CSV is too large. Split it into smaller batches.')

    const parsed = parseRows(csv)
    const rows = parsed.flatMap((p) => ('row' in p ? [p.row] : []))
    const errors: string[] = parsed.flatMap((p) => ('error' in p ? [p.error] : []))
    if (rows.length === 0) {
      if (errors.length > 0) return NextResponse.json({ error: `No valid rows. ${errors.slice(0, 5).join('; ')}` }, { status: 400 })
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
    // Emails seen earlier in this same file — a pasted CSV with the same
    // person twice must not create two entries.
    const seen = new Set<string>()

    for (const row of rows) {
      try {
        const passwordError = passwordValidationError(row.password)
        if (passwordError) {
          errors.push(`${row.full_name}: ${passwordError}`)
          continue
        }

        if (seen.has(row.email)) {
          skipped++
          continue
        }
        seen.add(row.email)

        // Check if player already exists — never overwrite their password.
        // limit(1).maybeSingle(): .single() errors on 0 or 2+ matches, and an
        // error here would read as "not found" and attempt a duplicate insert.
        const { data: existing, error: lookupError } = await supabase
          .from('players')
          .select('id')
          .ilike('email', escapeIlike(row.email))
          .limit(1)
          .maybeSingle()
        if (lookupError) {
          console.error('import lookup error', lookupError)
          errors.push(`${row.full_name}: could not check for an existing account`)
          continue
        }

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
          if (error.code === '23505') {
            skipped++
            continue
          }
          console.error('import insert error', error)
          errors.push(`${row.full_name}: could not be saved`)
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
