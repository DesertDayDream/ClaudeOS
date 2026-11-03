Build a single-page website in this folder: a tip calculator and bill splitter.

Files: index.html is the entry point. You may add CSS and JS files in this folder.
It must work when index.html is opened directly, with no build step, no server,
no external requests (no CDN fonts, scripts or images), and no console errors.

Page contents (use these exact data-testid attributes; the look is up to you):
- A <header> with an <h1 data-testid="title"> containing the text "Split the Bill".
- A form with labelled inputs:
    data-testid="bill"     number, the bill amount in dollars
    data-testid="tip"      number, tip percent (default 15)
    data-testid="people"   number, how many people share (default 1)
  and three preset buttons data-testid="tip-10", "tip-15", "tip-20" that set the tip percent.
- Results that update live as inputs change (no submit button needed):
    data-testid="tip-amount"   tip in dollars, formatted like $4.50
    data-testid="total"        bill plus tip, formatted like $34.50
    data-testid="per-person"   total divided by people, formatted like $17.25
  Round to the nearest cent (half up) only at the final display step.
- If bill is empty or negative, or people is not a whole number of at least 1,
  show data-testid="error" with a short message and show "$0.00" in the three results.
  When the input is valid, data-testid="error" must not be in the page (or must be hidden).
- A "How it works" section (data-testid="how") with exactly 3 numbered steps.
- An FAQ section (data-testid="faq") with exactly 3 questions. Each question is a
  button (data-testid="faq-q-1" … "faq-q-3") that shows or hides its answer
  (data-testid="faq-a-1" … "faq-a-3"); answers start hidden. They must work with the keyboard.
- A <footer> with a one-line note.

It must be usable on a phone and on a desktop. Make it look good and professional.
Example: bill 30.00, tip 15, people 2 → tip $4.50, total $34.50, per person $17.25.

When finished, reply with exactly: DONE
