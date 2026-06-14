<script lang="ts">
let {
	animated = false,
	size = 20,
}: {
	animated?: boolean;
	size?: number;
} = $props();
</script>

{#if animated}
<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 100 112" aria-hidden="true">
  <style>
    .lm-stroke {
      fill: none; stroke: #C8A882; stroke-width: 4.2;
      stroke-linecap: round; stroke-linejoin: round;
      stroke-dasharray: 160;
      animation: lm-s 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes lm-s {
      0%   { stroke-dashoffset: 160; opacity: 1; }
      60%  { stroke-dashoffset: 0;   opacity: 1; }
      82%  { stroke-dashoffset: 0;   opacity: 1; }
      100% { stroke-dashoffset: 0;   opacity: 0; }
    }
    .lm-cb {
      fill: none; stroke: #C8A882; stroke-width: 2.2;
      stroke-linecap: round; stroke-dasharray: 48;
      animation: lm-cb 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes lm-cb {
      0%,30% { stroke-dashoffset: 48; opacity: 0; }
      31%    { opacity: 1; }
      60%    { stroke-dashoffset: 0; opacity: 1; }
      82%    { opacity: 1; }
      100%   { opacity: 0; }
    }
    .lm-tkl {
      fill: none; stroke: #C8A882; stroke-width: 1.8;
      stroke-linecap: round; stroke-dasharray: 10;
      animation: lm-tkl 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes lm-tkl {
      0%,44% { stroke-dashoffset: 10; opacity: 0; }
      45%    { opacity: 1; }
      60%    { stroke-dashoffset: 0; opacity: 0.75; }
      82%    { opacity: 0.75; }
      100%   { opacity: 0; }
    }
    .lm-tkr {
      fill: none; stroke: #C8A882; stroke-width: 1.8;
      stroke-linecap: round; stroke-dasharray: 10;
      animation: lm-tkr 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes lm-tkr {
      0%,52% { stroke-dashoffset: 10; opacity: 0; }
      53%    { opacity: 1; }
      60%    { stroke-dashoffset: 0; opacity: 0.75; }
      82%    { opacity: 0.75; }
      100%   { opacity: 0; }
    }
    .lm-sfl {
      fill: none; stroke: #C8A882; stroke-width: 3.2;
      stroke-linecap: round; stroke-dasharray: 28;
      animation: lm-sfl 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes lm-sfl {
      0%,38% { stroke-dashoffset: 28; opacity: 0; }
      39%    { opacity: 1; }
      60%    { stroke-dashoffset: 0; opacity: 1; }
      82%    { opacity: 1; }
      100%   { opacity: 0; }
    }
    .lm-sfr {
      fill: none; stroke: #C8A882; stroke-width: 3.2;
      stroke-linecap: round; stroke-dasharray: 28;
      animation: lm-sfr 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes lm-sfr {
      0%,46% { stroke-dashoffset: 28; opacity: 0; }
      47%    { opacity: 1; }
      60%    { stroke-dashoffset: 0; opacity: 1; }
      82%    { opacity: 1; }
      100%   { opacity: 0; }
    }
    .lm-apx {
      fill: #C8A882;
      animation: lm-apx 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    }
    @keyframes lm-apx {
      0%   { opacity: 1; }
      82%  { opacity: 1; }
      100% { opacity: 0; }
    }
  </style>
  <path class="lm-stroke" d="M50 19 C46 40 36 64 24 88"/>
  <path class="lm-stroke" d="M50 19 C54 40 64 64 76 88"/>
  <line class="lm-cb"  x1="27" y1="57" x2="73" y2="57"/>
  <line class="lm-tkl" x1="27" y1="52" x2="27" y2="62"/>
  <line class="lm-tkr" x1="73" y1="52" x2="73" y2="62"/>
  <line class="lm-sfl" x1="14" y1="90" x2="36" y2="90"/>
  <line class="lm-sfr" x1="64" y1="90" x2="86" y2="90"/>
  <circle class="lm-apx" cx="50" cy="19" r="3.5"/>
</svg>
{:else}
<svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 100 112" aria-hidden="true">
  <path fill="none" stroke="#C8A882" stroke-width="4.2" stroke-linecap="round"
    d="M50 19 C46 40 36 64 24 88"/>
  <path fill="none" stroke="#C8A882" stroke-width="4.2" stroke-linecap="round"
    d="M50 19 C54 40 64 64 76 88"/>
  <line x1="27" y1="57" x2="73" y2="57" stroke="#C8A882" stroke-width="2.2" stroke-linecap="round"/>
  <line x1="27" y1="52" x2="27" y2="62" stroke="#C8A882" stroke-width="1.8" stroke-linecap="round" opacity="0.75"/>
  <line x1="73" y1="52" x2="73" y2="62" stroke="#C8A882" stroke-width="1.8" stroke-linecap="round" opacity="0.75"/>
  <line x1="14" y1="90" x2="36" y2="90" stroke="#C8A882" stroke-width="3.2" stroke-linecap="round"/>
  <line x1="64" y1="90" x2="86" y2="90" stroke="#C8A882" stroke-width="3.2" stroke-linecap="round"/>
  <circle cx="50" cy="19" r="3.5" fill="#C8A882"/>
</svg>
{/if}
