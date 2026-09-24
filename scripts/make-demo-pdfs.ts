// Generates the two demo packets in demo/ (run: npm run demo:pdfs).
//   demo/clean/  - invoice + BOL + rate confirmation that match FactorCloud sandbox data -> PASS
//   demo/review/ - address/phone differ from FactorCloud and the rate con disagrees on amount -> REVIEW
// Bump the invoice numbers before each live demo; FactorCloud may reject duplicates.

import { mkdirSync, writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

const CLIENT = {
  name: "Will's Test Trucking LLC",
  lines: ['1234 Testing Lane', 'Dallas, TX 75205', '(334) 377-0535', 'MC# 000000'],
};

interface Debtor {
  name: string;
  street: string;
  cityLine: string;
  phone: string;
}

const ACME: Debtor = {
  name: 'Acme Manufacturing LLC',
  street: 'Fake address',
  cityLine: 'Dallas, TX 75205',
  phone: '(334) 377-0535',
};

interface Packet {
  dir: string;
  invoiceNumber: string;
  load: string;
  date: string;
  amount: number;
  rateConAmount: number;
  debtor: Debtor;
}

const packets: Packet[] = [
  { dir: 'clean', invoiceNumber: 'Test004', load: 'Load004', date: '09/24/2026', amount: 9750, rateConAmount: 9750, debtor: ACME },
  {
    dir: 'review',
    invoiceNumber: 'Test005',
    load: 'Load005',
    date: '09/24/2026',
    amount: 12000,
    rateConAmount: 10000,
    debtor: { ...ACME, street: '123 Main Street', phone: '(214) 555-0100' },
  },
];

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

class Writer {
  y = 740;
  constructor(
    private page: PDFPage,
    private font: PDFFont,
    private bold: PDFFont,
  ) {}
  text(t: string, opts: { x?: number; size?: number; bold?: boolean; gap?: number } = {}) {
    this.page.drawText(t, { x: opts.x ?? 50, y: this.y, size: opts.size ?? 11, font: opts.bold ? this.bold : this.font, color: rgb(0.1, 0.12, 0.2) });
    this.y -= opts.gap ?? (opts.size ?? 11) + 6;
  }
  at(x: number, y: number, t: string, size = 11, bold = false) {
    this.page.drawText(t, { x, y, size, font: bold ? this.bold : this.font, color: rgb(0.1, 0.12, 0.2) });
  }
  rule() {
    this.page.drawLine({ start: { x: 50, y: this.y + 6 }, end: { x: 562, y: this.y + 6 }, thickness: 0.8, color: rgb(0.7, 0.72, 0.78) });
    this.y -= 12;
  }
  space(n = 10) {
    this.y -= n;
  }
}

async function newDoc() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const w = new Writer(page, await pdf.embedFont(StandardFonts.Helvetica), await pdf.embedFont(StandardFonts.HelveticaBold));
  return { pdf, page, w };
}

async function invoice(p: Packet) {
  const { pdf, w } = await newDoc();
  w.text(CLIENT.name, { size: 18, bold: true });
  CLIENT.lines.forEach((l) => w.text(l, { size: 10, gap: 14 }));
  w.at(400, 740, 'INVOICE', 22, true);
  w.at(400, 712, `Invoice #: ${p.invoiceNumber}`);
  w.at(400, 696, `Invoice date: ${p.date}`);
  w.at(400, 680, `Load #: ${p.load}`);
  w.at(400, 664, 'Terms: Net 30');
  w.space(20);
  w.text('BILL TO', { bold: true, size: 10 });
  [p.debtor.name, p.debtor.street, p.debtor.cityLine, `Phone: ${p.debtor.phone}`].forEach((l) => w.text(l, { gap: 15 }));
  w.space(16);
  w.rule();
  w.at(50, w.y, 'Description', 10, true);
  w.at(460, w.y, 'Amount', 10, true);
  w.space(18);
  w.at(50, w.y, `Line haul - ${p.load} - Houston, TX to Dallas, TX`);
  w.at(460, w.y, money(p.amount));
  w.space(24);
  w.rule();
  w.at(360, w.y, 'TOTAL DUE', 12, true);
  w.at(460, w.y, money(p.amount), 12, true);
  w.space(40);
  w.text('Please remit payment per the notice of assignment on file.', { size: 9 });
  return pdf.save();
}

async function bol(p: Packet) {
  const { pdf, w } = await newDoc();
  w.text('STRAIGHT BILL OF LADING', { size: 18, bold: true });
  w.text(`BOL / Load #: ${p.load}`, { bold: true });
  w.text(`Ship date: ${p.date}`);
  w.space(8);
  w.text('SHIPPER', { bold: true, size: 10 });
  ['Gulf Coast Supply Co', '500 Harbor Rd', 'Houston, TX 77002'].forEach((l) => w.text(l, { gap: 15 }));
  w.space(8);
  w.text('CONSIGNEE', { bold: true, size: 10 });
  [p.debtor.name, p.debtor.street, p.debtor.cityLine].forEach((l) => w.text(l, { gap: 15 }));
  w.space(8);
  w.text(`CARRIER: ${CLIENT.name}`, { bold: true });
  w.rule();
  w.text('22 pallets - industrial fasteners - 38,400 lbs');
  w.space(30);
  w.text('Received in good order:', { size: 10 });
  w.at(60, w.y - 4, 'J. Rivera', 20);
  w.space(16);
  w.text('Receiver signature        Date: ' + p.date, { size: 9 });
  return pdf.save();
}

async function pod(p: Packet) {
  const { pdf, w } = await newDoc();
  w.text('PROOF OF DELIVERY', { size: 18, bold: true });
  w.text(`Load #: ${p.load}`, { bold: true });
  w.text(`Delivered: ${p.date}`);
  w.text(`Carrier: ${CLIENT.name}`);
  w.text(`Delivered to: ${p.debtor.name}, ${p.debtor.cityLine}`);
  w.space(30);
  w.at(60, w.y, 'M. Chen', 20);
  w.space(18);
  w.text('Receiver signature', { size: 9 });
  return pdf.save();
}

async function rateCon(p: Packet) {
  const { pdf, w } = await newDoc();
  w.text('RATE CONFIRMATION', { size: 18, bold: true });
  w.text(`Load #: ${p.load}`, { bold: true });
  w.text(`Date: ${p.date}`);
  w.space(8);
  w.text('CUSTOMER', { bold: true, size: 10 });
  [p.debtor.name, p.debtor.street, p.debtor.cityLine, `Phone: ${p.debtor.phone}`].forEach((l) => w.text(l, { gap: 15 }));
  w.space(8);
  w.text(`Carrier: ${CLIENT.name}`);
  w.text('Pickup: Houston, TX    Delivery: Dallas, TX');
  w.rule();
  w.text(`Total agreed rate: ${money(p.rateConAmount)}`, { bold: true, size: 13 });
  return pdf.save();
}

async function main() {
  for (const p of packets) {
    const dir = `demo/${p.dir}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${p.invoiceNumber}_Invoice.pdf`, await invoice(p));
    writeFileSync(`${dir}/${p.load}_RateConfirmation.pdf`, await rateCon(p));
    if (p.dir === 'clean') writeFileSync(`${dir}/${p.load}_BOL.pdf`, await bol(p));
    else writeFileSync(`${dir}/${p.load}_POD.pdf`, await pod(p));
  }
  console.log('Wrote demo/clean and demo/review');
}

main();
