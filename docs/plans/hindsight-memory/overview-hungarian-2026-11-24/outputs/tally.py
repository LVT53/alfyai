import json,re,sys,glob,os
# usage: python3 tally.py <this folder>   (the mechanical slips of every round)
scr=sys.argv[1]
rounds=["before","after1","after2","after3","after3b","after3c"]
def sentences(t):
    t=re.sub(r"\bK\. ","K_ ",t)
    return [s for s in re.split(r"(?<=[.!?])\s+",t.strip()) if s]
def det(r):
    t=r["text"]; hu=r["language"]=="hu"; out={}
    out["freelance"]=bool(re.search(r"freelance",t,re.I)) if hu else False
    out["japant"]=bool(re.search(r"japánt tanul",t)) if hu else False
    out["bakony_noarticle"]=bool(re.search(r"(?<!a )(?<!A )Bakonyban",t)) if hu else False
    out["peter"]=bool(re.search(r"\bPeter\b",t))
    n=len(sentences(t)); out["over6"]=n>6; out["under3"]=n<3
    out["meta"]=bool(re.search(r"\b(memory|entries|entry|bejegyz|memória)",t,re.I))
    out["markup"]=bool(re.search(r"[*#`\"„“]|^\s*[-•]",t))
    return out,n,len(t)
keys=["freelance","japant","bakony_noarticle","peter","over6","under3","meta","markup"]
print("%-8s %-9s %-4s n | "%("round","cell","lang")+" ".join("%-8s"%k[:8] for k in keys)+" | avg sentences / chars")
for rd in rounds:
    d=json.load(open(os.path.join(scr,"%s.json"%rd)))
    for scope in ("personal","project"):
        for lang in ("hu","en"):
            rs=[r for r in d["results"] if r["scope"]==scope and r["language"]==lang and "text" in r]
            if not rs: continue
            tot={k:0 for k in keys}; ns=0; cs=0
            for r in rs:
                o,n,c=det(r)
                for k in keys: tot[k]+=o[k]
                ns+=n; cs+=c
            print("%-8s %-9s %-4s %d | "%(rd,scope,lang,len(rs))+" ".join("%-8d"%tot[k] for k in keys)+" | %.1f / %d"%(ns/len(rs),cs/len(rs)))
