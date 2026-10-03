# Wei Ye — Academic Website

Personal academic website for Wei Ye, Ph.D. Candidate in Economics at Fordham University.

**Live site:** https://weiyeecon.github.io/

## Update content

- `_pages/about.html`: biography, job market information, and recent activity.
- `_data/research.yml`: paper titles, authors, publication status, abstract, and links. This is the content source for the homepage highlights and research pages.
- `_pages/research.html`: research page structure.
- `_pages/teaching.html`: teaching and student mentoring.
- `_pages/cv.html`: web CV; replace `assets/pdf/CV_academic.pdf` when updating the downloadable CV.
- `assets/img/headshot_compress.png`: professional portrait.
- `assets/css/academic.css`: responsive visual design.
- `assets/js/academic.js`: accessible mobile navigation.

The public pages use standalone HTML with Jekyll Liquid data rendering. The `/publications/` address remains available for older links and points search engines to `/research/` as its canonical URL. Starter examples are excluded in `_config.yml`.

## Preview and checks

```sh
bundle install
npm ci
npm run lint:prettier
npm run lint:style-contract
JEKYLL_ENV=production bundle exec jekyll build
bundle exec jekyll serve
```

Preview at `http://localhost:4000/`. This user site serves at the domain root, so keep `baseurl` empty.

The existing `Deploy site` workflow builds changes on `main` and publishes the generated site to `gh-pages`. Configure GitHub Pages to serve from the `gh-pages` branch. The stylesheet purge configuration preserves the navigation classes added by JavaScript.

Content was updated from the October 2, 2026 academic CV. Scheduled visits and presentations are labeled as upcoming.
