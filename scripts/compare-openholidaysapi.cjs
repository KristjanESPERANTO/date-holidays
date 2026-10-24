#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')
const Holidays = require('../lib/index.cjs')

const DEFAULT_SOURCE = path.resolve(__dirname, '../../openholidaysapi.data/src')

function parseArgs (args) {
  const options = { source: DEFAULT_SOURCE, json: false, verbose: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--source') options.source = path.resolve(args[++index])
    else if (arg === '--country') options.country = args[++index].toUpperCase()
    else if (arg === '--from') options.from = Number(args[++index])
    else if (arg === '--to') options.to = Number(args[++index])
    else if (arg === '--json') options.json = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function parseCsvLine (line) {
  const fields = []
  let field = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') field += line[++index]
      else quoted = !quoted
    } else if (character === ';' && !quoted) {
      fields.push(field)
      field = ''
    } else field += character
  }
  fields.push(field)
  return fields
}

function readPublicHolidays (source, country) {
  const filename = path.join(source, country.toLowerCase(), 'holidays', 'holidays.public.csv')
  if (!fs.existsSync(filename)) return []
  const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(Boolean)
  const headers = parseCsvLine(lines.shift())
  return lines.map(parseCsvLine).map((fields) => Object.fromEntries(
    headers.map((header, index) => [header, fields[index] || ''])
  )).filter((holiday) => holiday.Type === 'Public')
}

function datesFromRows (rows, from, to) {
  return new Set(rows
    .filter((holiday) => !holiday.Subdivisions)
    .map((holiday) => holiday.StartDate.slice(0, 10))
    .filter((date) => {
      const year = Number(date.slice(0, 4))
      return year >= from && year <= to
    }))
}

function datesFromDateHolidays (country, from, to) {
  const dates = new Set()
  const substituteDates = new Set()
  const holidays = new Holidays(country, undefined, undefined, { types: ['public'] })
  for (let year = from; year <= to; year++) {
    holidays.getHolidays(year).forEach((holiday) => {
      const date = holiday.date.slice(0, 10)
      dates.add(date)
      if (holiday.substitute) substituteDates.add(date)
    })
  }
  return { dates, substituteDates }
}

function difference (left, right) {
  return [...left].filter((value) => !right.has(value)).sort()
}

function compareCountry (source, country, from, to) {
  const rows = readPublicHolidays(source, country)
  const nationalRows = rows.filter((holiday) => !holiday.Subdivisions)
  const regionalRows = rows.length - nationalRows.length
  const sourceDates = datesFromRows(rows, from, to)
  const { dates: dateHolidaysDates, substituteDates } = datesFromDateHolidays(country, from, to)
  const missingInOpenHolidays = difference(dateHolidaysDates, sourceDates)
  return {
    country,
    years: `${from}-${to}`,
    sourceNationalRows: nationalRows.length,
    sourceRegionalRows: regionalRows,
    sourceDates: sourceDates.size,
    dateHolidaysDates: dateHolidaysDates.size,
    equalDates: [...sourceDates].filter((date) => dateHolidaysDates.has(date)).sort(),
    missingInDateHolidays: difference(sourceDates, dateHolidaysDates),
    missingInOpenHolidays: missingInOpenHolidays.filter((date) => !substituteDates.has(date)),
    missingInOpenHolidaysSubstitute: missingInOpenHolidays.filter((date) => substituteDates.has(date))
  }
}

function getCountries (source, selectedCountry) {
  if (selectedCountry) return [selectedCountry]
  return fs.readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(source, entry.name, 'holidays', 'holidays.public.csv')))
    .map((entry) => entry.name.toUpperCase())
    .sort()
}

function printReport (results, verbose) {
  const matching = results.filter((result) => !result.missingInDateHolidays.length && !result.missingInOpenHolidays.length).length
  const totalRegional = results.reduce((sum, result) => sum + result.sourceRegionalRows, 0)
  const years = results[0] && results[0].years
  console.log(`OpenHolidays comparison (${years})`)
  console.log(`${matching}/${results.length} countries match by date; ${totalRegional} regional rows excluded`)
  console.log('')
  console.log('CC  Status  Equal  OH only  DH only  Substitute  Regional')
  console.log('--  ------  -----  -------  -------  ----------  --------')
  results.forEach((result) => {
    const status = result.missingInDateHolidays.length || result.missingInOpenHolidays.length ? 'DIFF' : 'OK'
    console.log([
      result.country.padEnd(2),
      status.padEnd(6),
      String(result.equalDates.length).padStart(5),
      String(result.missingInDateHolidays.length).padStart(7),
      String(result.missingInOpenHolidays.length).padStart(7),
      String(result.missingInOpenHolidaysSubstitute.length).padStart(10),
      String(result.sourceRegionalRows).padStart(8)
    ].join('  '))
  })
  if (verbose) {
    console.log('')
    results.filter((result) => result.missingInDateHolidays.length || result.missingInOpenHolidays.length || result.missingInOpenHolidaysSubstitute.length).forEach((result) => {
      console.log(`${result.country}:`)
      if (result.missingInDateHolidays.length) console.log(`  only OpenHolidays: ${result.missingInDateHolidays.join(', ')}`)
      if (result.missingInOpenHolidays.length) console.log(`  only date-holidays: ${result.missingInOpenHolidays.join(', ')}`)
      if (result.missingInOpenHolidaysSubstitute.length) console.log(`  only date-holidays (substitute day, expected): ${result.missingInOpenHolidaysSubstitute.join(', ')}`)
    })
  }
}

function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log('Usage: node scripts/compare-openholidaysapi.cjs [options]')
    console.log('  --source DIR       openholidaysapi.data/src (default: sibling repository)')
    console.log('  --country CC       compare one country')
    console.log('  --from YEAR        first year (default: source minimum year)')
    console.log('  --to YEAR          last year (default: source maximum year)')
    console.log('  --json             output machine-readable JSON')
    console.log('  --verbose          include dates for countries with differences')
    return
  }

  const countries = getCountries(options.source, options.country)
  const rows = countries.flatMap((country) => readPublicHolidays(options.source, country))
  const years = rows.map((holiday) => Number(holiday.StartDate.slice(0, 4))).filter(Boolean)
  const from = options.from || Math.min(...years)
  const to = options.to || Math.max(...years)
  const results = countries.map((country) => compareCountry(options.source, country, from, to))
  if (options.json) console.log(JSON.stringify(results, null, 2))
  else printReport(results, options.verbose)
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}