import {createRoot} from "react-dom/client";
import {useAgentChatStore} from "../../src/stores/agent-chat-store";
import {useDocumentStore} from "../../src/stores/document-store";
import {AgentChatDrawer} from "../../src/components/agent-chat/agent-chat-drawer";
import "../../src/styles/globals.css";
const store=useAgentChatStore.getState();
useDocumentStore.setState({initialized:true});
useAgentChatStore.setState({activeProjectPath:"/fixture",activeTabId:"one",restoringChats:false,tabs:["one","two"].map(id=>({
  ...store.tabs[0],id,title:id,projectPath:"/fixture",messages:Array.from({length:60},(_,i)=>({
    id:id+i,type:"agentMessage",text:(`### Result

A scientific result with **emphasis** and $E=mc^2$.

`).repeat(5)
  }))
}))});
createRoot(document.body).render(<div style={{height:"100vh",width:700,display:"flex",flexDirection:"column"}}><AgentChatDrawer fillHeight/></div>);
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function ready(){
  for(let i=0;i<1000;i++){if(!document.body.textContent?.includes("Loading conversation"))return;await pause(20);}
  throw new Error("Transcript did not finish");
}
(window as any).runSmoke=async()=>{
  await pause(100);await ready();
  useAgentChatStore.getState().setActiveTab("two");
  await pause(100);await ready();
  const idleStart=performance.now();
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const idleFramesMs=Math.round(performance.now()-idleStart);
  const timings=[], handlers=[];
  for(const id of ["one","two","one"]){
    const start=performance.now();
    const button=[...document.querySelectorAll("button")].find(b=>b.textContent?.trim()===id);
    if(!button)throw new Error("Tab missing");
    button.click();
    handlers.push(Math.round(performance.now()-start));
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    timings.push(Math.round(performance.now()-start));
    const text = document.querySelector("[aria-hidden=false]");
    if (!text || text.getBoundingClientRect().height < 100) throw new Error("Transcript has no visible area");
  }
  return {ok:true,warmSwitchMs:timings,clickHandlerMs:handlers,idleFramesMs,visibility:document.visibilityState};
};
