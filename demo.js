import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { Play, Pause, FileText, MessageSquare, MousePointerClick, Settings, Save, Send, Layers, Box, Map } from 'lucide-react';

// === 预制实体组件库数据 ===
const entityLibrary = [
  { 
    type: 'port', 
    label: '⚓ 新建港口', 
    md: '### 实体: 新建港口\n\n**当前状态**: 规划中\n**吞吐能力**: 5000 TEU/天\n\n#### 行为规则\n- [常态] 接收并处理进港请求。\n- [规划] 需 Agent 进一步补充调度规则...' 
  },
  { 
    type: 'ship', 
    label: '🚢 新建货轮', 
    md: '### 实体: 新建货轮\n\n**当前状态**: 停泊/待命\n**当前航速**: 0 节\n**目的地**: 待定\n\n#### 行为规则\n- [常态] 等待启航指令。\n- [规划] 需 Agent 进一步补充航线与避险规则...' 
  },
  { 
    type: 'hazard', 
    label: '🌪️ 异常气候/事件', 
    md: '### 实体: 异常事件\n\n**当前状态**: 潜在威胁\n**影响半径**: 100 海里\n\n#### 行为规则\n- [常态] 监控气象数据。\n- [广播] 警告周边所有船只减速。' 
  }
];

// 初始画布节点 (增加一个纯 2D 的抽象逻辑节点：台风)
const initialNodes = [
  { 
    id: 'port_1', 
    type: 'port', 
    label: '⚓ 上海港 (枢纽)', 
    x: 450, 
    y: 150, 
    md: '### 实体: 上海港\n\n**当前状态**: 正常运营\n**堆场余量**: 25%\n\n#### 行为规则\n- [常态] 接收到进港请求时，分配 1 号泊位和桥吊。\n- [作业] 桥吊开始卸载集装箱。' 
  },
  { 
    id: 'ship_1', 
    type: 'ship', 
    label: '🚢 远洋货轮 001', 
    x: 100, 
    y: 350, 
    md: '### 实体: 远洋货轮 001\n\n**当前状态**: 航行中\n**载箱量**: 1200 TEU\n**目的地**: 上海港\n\n#### 行为规则\n- [常态] 沿预定航线向目的地行驶。\n- [靠泊] 到达港口后，执行靠泊并等待卸货。' 
  },
  {
    id: 'hazard_1',
    type: 'hazard',
    label: '🌪️ 台风 "梅花" (2D抽象)',
    x: 150,
    y: 80,
    md: '### 实体: 台风 "梅花"\n\n**当前状态**: 活跃\n**风力等级**: 12级\n\n#### 行为规则\n- [常态] 在2D图层监控区域风险。\n- [干涉] 对关联的3D物理实体施加影响。'
  }
];

// 初始化连线：包含了 3D实体之间(航线) 以及 2D实体到3D实体(干涉线)
const initialEdges = [
  { id: 'edge_1', source: 'ship_1', target: 'port_1', type: 'route', status: 'active' },
  { id: 'edge_2', source: 'hazard_1', target: 'ship_1', type: 'impact', status: 'warning' }
];

// 识别哪些节点是 3D 物理实体（在这个原型中，只有预设的 port_1 和 ship_1 拥有 3D 模型渲染）
const is3DNode = (nodeId) => ['port_1', 'ship_1'].includes(nodeId);

// 简单的 Markdown 渲染器
const SimpleMarkdown = ({ text }) => {
  const renderText = (str) => {
    let html = str
      .replace(/^### (.*$)/gim, '<h3 class="text-lg font-bold text-slate-100 mt-4 mb-2">$1</h3>')
      .replace(/^#### (.*$)/gim, '<h4 class="text-md font-semibold text-slate-200 mt-3 mb-1">$1</h4>')
      .replace(/\*\*(.*?)\*\*/gim, '<strong class="text-blue-400">$1</strong>')
      .replace(/\[(.*?)\]/gim, '<span class="px-1.5 py-0.5 rounded bg-slate-700 text-teal-300 text-sm">$1</span>')
      .replace(/^- (.*$)/gim, '<li class="ml-4 list-disc text-slate-300 my-1">$1</li>')
      .replace(/\n/gim, '<br/>');
    return { __html: html };
  };
  return <div className="text-sm leading-relaxed" dangerouslySetInnerHTML={renderText(text)} />;
};

export default function App() {
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [selectedNodeId, setSelectedNodeId] = useState('hazard_1');
  const [viewMode, setViewMode] = useState('2d'); 
  
  const [chatMessages, setChatMessages] = useState([
    { role: 'agent', content: '提示：切换到【3D物理场景】并点击【编译并运行】。您可以自由拖拽2D图层的“台风”节点，连线会自动追踪移动的3D货轮！' }
  ]);
  const [inputText, setInputText] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [isTyping, setIsTyping] = useState(false);

  const [simProgress, setSimProgress] = useState(0);

  // 核心：用于抓取 3D 实体在屏幕上的 2D 坐标
  const mainViewRef = useRef(null);
  const elements3DRef = useRef({});
  const [positions3D, setPositions3D] = useState({});

  const selectedNode = nodes.find(n => n.id === selectedNodeId);

  // 仿真运行逻辑
  useEffect(() => {
    let timer;
    if (isRunning) {
      timer = setInterval(() => {
        setSimProgress(prev => (prev >= 100 ? 100 : prev + 1));
      }, 50);
    } else {
      setSimProgress(0); 
    }
    return () => clearInterval(timer);
  }, [isRunning]);

  // 核心：实时更新 3D 实体到 2D 屏幕坐标的映射
  const update3DPositions = () => {
    if (!mainViewRef.current || viewMode !== '3d') return;
    const mainRect = mainViewRef.current.getBoundingClientRect();
    const newPos = {};
    
    Object.keys(elements3DRef.current).forEach(id => {
      const el = elements3DRef.current[id];
      if (el) {
        const rect = el.getBoundingClientRect();
        // 计算 3D 元素在相对主视口中的中心坐标
        newPos[id] = {
          x: rect.left - mainRect.left + rect.width / 2,
          y: rect.top - mainRect.top + rect.height / 2
        };
      }
    });
    setPositions3D(newPos);
  };

  // 每当进度更新或视口模式改变时，重新计算 3D 映射坐标
  useLayoutEffect(() => {
    update3DPositions();
    window.addEventListener('resize', update3DPositions);
    return () => window.removeEventListener('resize', update3DPositions);
  }, [simProgress, viewMode]);

  // 获取连线端点：自动处理 2D 节点和 3D 实体的维度差异
  const getEdgePoint = (nodeId) => {
    // 如果在 3D 模式且是 3D 实体，返回追踪到的屏幕物理坐标
    if (viewMode === '3d' && is3DNode(nodeId) && positions3D[nodeId]) {
      return positions3D[nodeId];
    }
    // 否则返回其在 2D 图层的逻辑坐标
    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      return { x: node.x + 96, y: node.y + 40 }; // 节点宽度的一半和高度的一半
    }
    return { x: 0, y: 0 };
  };

  // === 统一的交互事件处理 (支持跨维度拖拽) ===
  const [draggingNode, setDraggingNode] = useState(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });

  const handleMouseDown = (e, node) => {
    e.stopPropagation();
    setSelectedNodeId(node.id);
    
    // 如果在 3D 模式下试图拖拽 3D 实体，则忽略（因为它们的坐标是由物理引擎驱动的）
    if (viewMode === '3d' && is3DNode(node.id)) return;

    const rect = mainViewRef.current.getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left - node.x,
      y: e.clientY - rect.top - node.y
    });
    setDraggingNode(node.id);
  };

  const handleMouseMove = (e) => {
    if (!draggingNode) return; 
    const rect = mainViewRef.current.getBoundingClientRect();
    const newX = e.clientX - rect.left - dragOffset.x;
    const newY = e.clientY - rect.top - dragOffset.y;
    setNodes(nodes.map(n => n.id === draggingNode ? { ...n, x: newX, y: newY } : n));
  };

  const handleMouseUp = () => setDraggingNode(null);

  const onDragStartLibraryItem = (e, itemTemplate) => {
    e.dataTransfer.setData('application/json', JSON.stringify(itemTemplate));
    e.dataTransfer.effectAllowed = 'copy';
  };

  const onDragOverCanvas = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDropCanvas = (e) => {
    e.preventDefault();
    const itemData = e.dataTransfer.getData('application/json');
    if (!itemData) return;

    try {
      const template = JSON.parse(itemData);
      const rect = mainViewRef.current.getBoundingClientRect();
      const newId = `${template.type}_${Date.now()}`;
      const dropX = e.clientX - rect.left - 96; 
      const dropY = e.clientY - rect.top - 40;  

      const newNode = {
        id: newId, type: template.type, label: template.label, x: dropX, y: dropY, md: template.md
      };

      setNodes(prev => [...prev, newNode]);
      setSelectedNodeId(newId); 
    } catch (err) {}
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!inputText.trim() || !selectedNode) return;

    const userMsg = inputText.trim();
    setChatMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setInputText('');
    setIsTyping(true);

    setTimeout(() => {
      let newRule = `\n- [新增] ${userMsg}`;
      setNodes(prevNodes => prevNodes.map(n => n.id === selectedNodeId ? { ...n, md: n.md + newRule } : n));
      setChatMessages(prev => [...prev, { role: 'agent', content: `规则已更新。` }]);
      setIsTyping(false);
    }, 1000);
  };

  // === 3D 物理场景底座 ===
  const render3DScene = () => {
    const shipTranslateX = simProgress < 50 ? 200 - (simProgress * 4) : 0; 
    const craneTranslateY = simProgress > 60 && simProgress < 90 ? (simProgress % 10 > 5 ? -20 : 0) : -40; 
    
    return (
      <div className="absolute inset-0 bg-slate-900 overflow-hidden flex items-center justify-center perspective-[1200px] z-0 pointer-events-none">
        <div 
          className="relative w-[600px] h-[600px] transition-transform duration-100 ease-linear pointer-events-auto"
          style={{ transform: 'rotateX(60deg) rotateZ(-35deg)', transformStyle: 'preserve-3d' }}
        >
          {/* 码头地基 3D 对象 (绑定 Ref 以追踪坐标) */}
          <div 
            ref={el => elements3DRef.current['port_1'] = el}
            onMouseDown={(e) => handleMouseDown(e, {id: 'port_1'})}
            className={`absolute top-1/2 left-0 w-[300px] h-[300px] bg-slate-700 border-2 flex flex-wrap p-4 cursor-pointer transition-colors ${selectedNodeId === 'port_1' ? 'border-blue-400' : 'border-slate-600'}`}
            style={{ transform: 'translateZ(10px)', transformStyle: 'preserve-3d' }}
          >
            <div className="w-16 h-24 bg-rose-700 absolute top-10 left-10 shadow-lg" style={{ transform: 'translateZ(20px)' }}></div>
            <div className="absolute top-0 right-0 w-8 h-full bg-yellow-600/20 border-l border-yellow-500 flex flex-col justify-center items-center" style={{ transformStyle: 'preserve-3d' }}>
               <div className="w-32 h-4 bg-yellow-500 absolute -left-16" style={{ transform: 'translateZ(100px)' }}></div>
               <div className="w-4 h-32 bg-yellow-600 absolute" style={{ transform: 'translateZ(50px) rotateX(90deg)' }}></div>
               <div className="w-6 h-6 bg-slate-900 absolute transition-transform duration-300" style={{ transform: `translateZ(${100 + craneTranslateY}px) translateX(-40px)` }}></div>
            </div>
            {/* 3D 空间内的对象名称标签 */}
            <div className="absolute text-[12px] font-bold text-white/80 bg-slate-900/50 px-2 py-1 rounded" style={{ transform: 'translateZ(120px) rotateX(90deg) rotateY(35deg)'}}>上海港</div>
          </div>

          {/* 货轮 3D 对象 (绑定 Ref 以追踪坐标) */}
          <div 
            ref={el => elements3DRef.current['ship_1'] = el}
            onMouseDown={(e) => handleMouseDown(e, {id: 'ship_1'})}
            className={`absolute top-1/2 w-[180px] h-[60px] bg-slate-800 border-2 shadow-2xl flex items-center justify-center transition-transform duration-75 cursor-pointer ${selectedNodeId === 'ship_1' ? 'border-blue-400' : 'border-slate-600'}`}
            style={{ left: '320px', transform: `translateX(${shipTranslateX}px) translateZ(15px)`, transformStyle: 'preserve-3d' }}
          >
            <div className="w-20 h-12 bg-amber-600 absolute" style={{ transform: 'translateZ(20px) translateX(-20px)' }}></div>
            <div className="w-10 h-10 bg-white absolute right-2" style={{ transform: 'translateZ(30px)' }}></div> 
            <div className="absolute text-[12px] font-bold text-white/80 bg-slate-900/50 px-2 py-1 rounded" style={{ transform: 'translateZ(80px) rotateX(90deg) rotateY(35deg)'}}>货轮001</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-200 font-sans overflow-hidden">
      
      {/* 顶部控制栏 */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-slate-800 bg-slate-900 shadow-sm z-10">
        <div className="flex items-center space-x-2">
          <Settings className="w-5 h-5 text-blue-500" />
          <h1 className="font-bold text-lg tracking-wide text-white">NeuroSim<span className="text-blue-500 text-sm ml-1 font-normal">Agent Platform</span></h1>
        </div>

        {/* 维度切换开关 */}
        <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800 mx-8">
          <button 
            onClick={() => setViewMode('2d')}
            className={`flex items-center px-4 py-1.5 rounded-md text-sm font-medium transition-all ${viewMode === '2d' ? 'bg-slate-800 text-blue-400 shadow' : 'text-slate-400 hover:text-slate-200'}`}
          >
            <Map className="w-4 h-4 mr-2" /> 2D 逻辑拓扑
          </button>
          <button 
            onClick={() => setViewMode('3d')}
            className={`flex items-center px-4 py-1.5 rounded-md text-sm font-medium transition-all ${viewMode === '3d' ? 'bg-slate-800 text-purple-400 shadow' : 'text-slate-400 hover:text-slate-200'}`}
          >
            <Box className="w-4 h-4 mr-2" /> 3D 物理场景
          </button>
        </div>

        <div className="flex items-center space-x-4">
          <button 
            onClick={() => setIsRunning(!isRunning)}
            className={`flex items-center space-x-1 px-5 py-2 rounded-md text-sm font-bold transition-all ${
              isRunning ? 'bg-amber-600 hover:bg-amber-500 text-white shadow-[0_0_15px_rgba(217,119,6,0.5)]' : 'bg-emerald-600 hover:bg-emerald-500 text-white'
            }`}
          >
            {isRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            <span>{isRunning ? '终止推演' : '编译并运行'}</span>
          </button>
        </div>
      </header>

      <main className="flex flex-1 overflow-hidden">
        
        {/* 左侧实体库 */}
        <div className="w-60 flex flex-col border-r border-slate-800 bg-slate-950 shrink-0 z-30 shadow-xl transition-all">
          <div className="flex items-center px-4 py-3 bg-slate-900 border-b border-slate-800">
            <Layers className="w-4 h-4 text-blue-400 mr-2" />
            <h2 className="text-sm font-semibold">仿真实体库</h2>
          </div>
          <div className="flex-1 p-4 space-y-3 overflow-y-auto">
            <p className="text-xs text-slate-500 mb-4">无论 2D 或 3D 模式，皆可拖拽节点至画布</p>
            {entityLibrary.map((item, idx) => (
              <div key={idx} draggable onDragStart={(e) => onDragStartLibraryItem(e, item)} className="cursor-grab p-3 rounded-lg border border-slate-700 bg-slate-800 hover:border-blue-500 transition-colors shadow-sm flex items-center">
                <div className="font-medium text-slate-200 text-sm">{item.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 核心混合视口 (统一处理所有鼠标和拖放事件) */}
        <div 
          ref={mainViewRef}
          className={`flex-1 relative overflow-hidden bg-slate-900 ${viewMode === '2d' ? 'custom-grid-bg bg-opacity-50' : ''}`}
          style={viewMode === '2d' ? { backgroundImage: 'radial-gradient(circle, #334155 1px, transparent 1px)', backgroundSize: '30px 30px' } : {}}
          onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
          onDragOver={onDragOverCanvas} onDrop={onDropCanvas}
        >
          {/* UI 指示器 */}
          <div className="absolute top-4 left-4 flex items-center space-x-2 px-3 py-2 bg-slate-800/80 rounded-lg shadow border border-slate-700 pointer-events-none backdrop-blur-sm z-40">
            <MousePointerClick className="w-4 h-4 text-blue-400" />
            <span className="text-xs font-medium text-slate-300">
              {viewMode === '3d' ? '3D 混合 HUD 模式：纯 2D 逻辑对象会悬浮在物理场景之上' : '2D拓扑层：用于规划宏观逻辑与状态机'}
            </span>
          </div>

          {/* 维度 1: 渲染 3D 物理底层 (仅在 3D 模式下挂载) */}
          {viewMode === '3d' && render3DScene()}

          {/* 维度 2: SVG 跨维度连线层 (覆盖在最上方，实时贯穿 2D 与 3D) */}
          <svg className="absolute inset-0 w-full h-full pointer-events-none z-20">
            {edges.map(edge => {
              const startPos = getEdgePoint(edge.source);
              const endPos = getEdgePoint(edge.target);
              
              if (startPos.x === 0 && startPos.y === 0) return null; // 节点未就绪

              const cp1X = startPos.x + (endPos.x - startPos.x) / 2;
              
              // 根据连线类型设定不同样式
              const lineColor = edge.type === 'impact' ? '#f43f5e' : '#3b82f6';
              const lineDash = edge.type === 'impact' ? '4 4' : '8 8';
              
              return (
                <g key={edge.id}>
                  <path d={`M ${startPos.x} ${startPos.y} C ${cp1X} ${startPos.y}, ${cp1X} ${endPos.y}, ${endPos.x} ${endPos.y}`} fill="none" stroke="#0f172a" strokeWidth="6"/>
                  <path d={`M ${startPos.x} ${startPos.y} C ${cp1X} ${startPos.y}, ${cp1X} ${endPos.y}, ${endPos.x} ${endPos.y}`} fill="none" stroke={lineColor} strokeWidth="2" strokeDasharray={lineDash} className={isRunning ? "path-anim" : ""}/>
                  {/* 连线标签 */}
                  <rect x={cp1X - 20} y={startPos.y + (endPos.y - startPos.y)/2 - 10} width="40" height="20" rx="4" fill="#1e293b" />
                  <text x={cp1X} y={startPos.y + (endPos.y - startPos.y)/2 + 4} fill={lineColor} fontSize="10" textAnchor="middle">{edge.type === 'impact' ? '干涉' : '航线'}</text>
                </g>
              );
            })}
          </svg>
          <style>{`@keyframes dash { to { stroke-dashoffset: -16; } } .path-anim { animation: dash 2s linear infinite; }`}</style>

          {/* 维度 3: 2D HUD 悬浮图层节点 */}
          {nodes.map(node => {
            // 核心显隐逻辑：如果在 3D 模式下，且该节点已经是 3D 物理实体，则不要在 2D 图层里重复渲染它的卡片！
            if (viewMode === '3d' && is3DNode(node.id)) return null;

            let nodeStyle = selectedNodeId === node.id 
              ? 'border-blue-500 bg-slate-800 shadow-xl shadow-blue-500/40' 
              : 'border-slate-700 bg-slate-800/90 hover:border-slate-500 shadow-md';
              
            if (node.type === 'hazard' && selectedNodeId !== node.id) {
              nodeStyle = 'border-rose-500/50 bg-rose-950/80 hover:border-rose-400 shadow-lg shadow-rose-900/20';
            }

            // 在 3D 模式下，2D 节点采用更具科技感（HUD）的透明磨砂外观
            const hudStyle = viewMode === '3d' ? 'backdrop-blur-xl bg-opacity-70 border-opacity-70' : 'backdrop-blur-md';

            return (
              <div
                key={node.id}
                onMouseDown={(e) => handleMouseDown(e, node)}
                className={`absolute cursor-move select-none p-4 rounded-xl border-2 transition-shadow w-48 z-30 ${nodeStyle} ${hudStyle}`}
                style={{ left: node.x, top: node.y }}
              >
                <div className="font-semibold text-slate-100"><span className="truncate">{node.label}</span></div>
                <div className="mt-2 text-xs text-slate-400 flex justify-between items-center">
                  <span>类型: {node.type}</span>
                  {isRunning && <span className="flex h-2 w-2 relative"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span></span>}
                </div>
              </div>
            );
          })}
        </div>

        {/* 右侧面板 */}
        <div className="w-96 flex flex-col border-l border-slate-800 bg-slate-950 shrink-0 shadow-2xl z-30 transition-all">
          <div className="flex-1 flex flex-col h-1/2 border-b border-slate-800 overflow-hidden">
            <div className="flex items-center px-4 py-3 bg-slate-900 border-b border-slate-800">
              <FileText className="w-4 h-4 text-emerald-500 mr-2" />
              <h2 className="text-sm font-semibold">实体行为配置 (Markdown)</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-5 bg-slate-950 font-mono scrollbar-thin">
              {selectedNode ? <SimpleMarkdown text={selectedNode.md} /> : <div className="h-full flex items-center justify-center text-slate-500 text-sm">选择实体查看逻辑</div>}
            </div>
          </div>

          <div className="flex-1 flex flex-col h-1/2 overflow-hidden bg-slate-900/50">
            <div className="flex items-center px-4 py-3 bg-slate-900 border-b border-slate-800">
              <MessageSquare className="w-4 h-4 text-blue-500 mr-2" />
              <h2 className="text-sm font-semibold">行为定义 Assistant</h2>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {chatMessages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`w-5/6 rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${msg.role === 'user' ? 'bg-blue-600 text-white rounded-tr-sm' : 'bg-slate-800 text-slate-200 border border-slate-700 rounded-tl-sm'}`}>
                    {msg.content}
                  </div>
                </div>
              ))}
            </div>
            <div className="p-3 bg-slate-900 border-t border-slate-800">
              <form onSubmit={handleSendMessage} className="relative flex items-center">
                <input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="与 Agent 对话修改规则..." disabled={isTyping} className="w-full bg-slate-950 border border-slate-700 text-slate-200 text-sm rounded-lg pl-4 pr-12 py-3 focus:outline-none focus:border-blue-500" />
                <button type="submit" disabled={!inputText.trim() || isTyping} className="absolute right-2 p-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded-md"><Send className="w-4 h-4" /></button>
              </form>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}