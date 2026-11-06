import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import { includeInteractionRows, keyboardNeighbours, VirtualRows } from "./virtual-rows";

it("keeps focused/dragged rows and their keyboard neighbours without mounting the whole gap", () => {
  const range={startIndex:60,endIndex:65,overscan:2,count:200};
  const included=includeInteractionRows(range,[1,198,60]);
  expect(included).toEqual([0,1,2,58,59,60,61,62,63,64,65,66,67,197,198,199]);
  expect(includeInteractionRows({...range,startIndex:0,endIndex:1},[0,199])).toEqual([0,1,2,3,198,199]);
});
it("renders all short lists but bounds long lists even in server HTML", () => {
  const render=(count:number)=>renderToString(<VirtualRows items={Array.from({length:count},(_,id)=>({id:String(id)}))}
    getKey={item=>item.id} getScrollParent={()=>null} estimateSize={()=>80}
    renderRow={(item,_index,props)=><div {...props}>Row {item.id}</div>}/>);
  expect((render(100).match(/data-virtual-row-id=/g)??[])).toHaveLength(100);
  const long=render(1000); const mounted=(long.match(/data-virtual-row-id=/g)??[]).length;
  expect(mounted).toBeGreaterThan(0); expect(mounted).toBeLessThan(30);
  expect(long).toContain('aria-setsize="1000"'); expect(long).toContain('data-virtual-spacer');
});
it("uses table spacer rows and absolute row indexes for cue-sheet semantics", () => {
  const html=renderToString(<table><VirtualRows as="tbody" colSpan={4} items={Array.from({length:300},(_,id)=>String(id))}
    getKey={id=>id} pinnedIds={["299"]} getScrollParent={()=>null} estimateSize={()=>80}
    renderRow={(id,_index,props)=><tr {...props}><td>{id}</td></tr>}/></table>);
  expect(html).toContain('aria-rowindex="301"'); expect(html).toContain('colSpan="4"');
  expect(html).not.toContain('<div');
});

it("finds keyboard neighbours across any number of noninteractive section headings", () => {
  expect(keyboardNeighbours(5,20,index=>index===1||index===18)).toEqual([1,18]);
  expect(keyboardNeighbours(0,20,index=>index===19)).toEqual([19]);
  expect(keyboardNeighbours(19,20,index=>index===0)).toEqual([0]);
});
