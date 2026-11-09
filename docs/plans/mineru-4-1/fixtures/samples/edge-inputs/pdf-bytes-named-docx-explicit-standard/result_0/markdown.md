# Throughput of Tiered Document Parsing

Ada Example, Bela Minta

**Abstract.** We compare four parsing tiers on a small synthetic corpus and report how layout analysis, optical character recognition and formula recognition change throughput and fidelity.

## 1. Introduction

Let denote the feature vector of page , and let be a mixing weight. The empirical loss xi ∈ Rd i α ∈ (0, 1) is and the regulariser satisfies ∥θ∥2 ≤ 1.1 The latency model that we fit L(θ) = ℓ(f (x ), y ) N 1 ∑i=1 N θ i i is given by

![](images/page_0_equation_6.jpg)

where is the number of pages and , , are fitted constants. In Section 2 we report the measured n a b c latencies, and we discuss the Hungarian-language test page in Section 3.

## 2. Method

Each document is parsed once per tier. The median and the 95th percentile of the wall-clock time are recorded for every run, and the results are summarised in Table 1 on the next page.

Table 1. Parsing latency by tier (milliseconds).

| Tier | Pages | Median | p95 |
| --- | --- | --- | --- |
| flash | 12 | 810 | 1 240 |
| basic | 12 | 1 126 | 2 980 |
| standard | 12 | 4 310 | 9 870 |
| advanced | 12 | 7 450 | 15 200 |

![](images/page_1_image_3.jpg)

Figure 1. Relative throughput by tier.

## 3. Hungarian test page

Az árvíztűrő tükörfúrógép egy magyar pangram: minden ékezetes magyar betűt tartalmaz, így az ő és az ű betűt is. A dokumentum feldolgozása után a szövegnek pontosan meg kell maradnia. ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP.

The quadratic term satisfies for every tier, and the fitted curve passes within of each c > 0 ϵ = 0.05 measurement.