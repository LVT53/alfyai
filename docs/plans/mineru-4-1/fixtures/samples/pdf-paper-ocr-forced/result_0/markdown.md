# Throughput of Tiered Document Parsing

Ada Example, Bela Minta

Abstract. We compare four parsing tiers on a small synthetic corpus and report how layout analysis, optical character recognition and formula recognition change throughput and fidelity.

## 1. Introduction

Let $\boldsymbol { x } _ { i } \in \mathbb { R } ^ { d }$ denote the feature vector of page $i ,$ and let $\alpha \in ( 0 , 1 )$ be a mixing weight. The empirical loss is $\begin{array} { r } { \mathcal { L } ( \theta ) = \frac { 1 } { N } \sum _ { i = 1 } ^ { N } \ell ( f _ { \theta } ( x _ { i } ) , y _ { i } ) } \end{array}$ and the regulariser satisfies $\| \boldsymbol { \theta } \| _ { 2 } \leq 1 . ^ { 1 }$ The latency model that we fit is given by

$$
T ( n ) = a + b   n + c   n ^ { 2 } , \qquad \int _ { 0 } ^ { \infty } e ^ { - x ^ { 2 } }   d x = { \frac { \sqrt { \pi } } { 2 } }\tag{1}
$$

where n is the number of pages and a, b, c are fitted constants. In Section 2 we report the measured latencies, and we discuss the Hungarian-language test page in Section 3.

## 2. Method

Each document is parsed once per tier. The median and the 95th percentile of the wall-clock time are recorded for every run, and the results are summarised in Table 1 on the next page.

<small><span class="docvortex-page-footnote" data-block-type="page_footnote" style="color:#6b7280">1 The norm constraint is the usual unit-ball regularisation; it is stated here only as an example footnote.</span></small>

Table 1. Parsing latency by tier (milliseconds).

| Tier | Pages | Median | p95 |
| --- | --- | --- | --- |
| flash | 12 | 810 | 1 240 |
| basic | 12 | 1126 | 2 980 |
| standard | 12 | 4310 | 9 870 |
| advanced | 12 | 7 450 | 15 200 |

![](images/page_1_chart_3.jpg)

Figure 1. Relative throughput by tier.

## 3. Hungarian test page

Az árvíztürő tükörfúrógép egy magyar pangram: minden ékezetes magyar betüt tartalmaz, így az ő és az ü betüt is. A dokumentum feldolgozása után a szövegnek pontosan meg kell maradnia. ÁRVíZTÜRő TÜKÖRFÚRÓGÉP.

The quadratic term satisfies $c > 0$ for every tier, and the fitted curve passes within $\epsilon = 0 . 0 5$ of each measurement.