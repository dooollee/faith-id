'use client';

import { useEffect, useRef, useState } from 'react';
import * as faceapi from 'face-api.js';
import { supabase } from '../supabase';

interface MemberType {
  id: string;
  name: string;
  created_at: string;
}

interface AttendanceLogType {
  id: string;
  checked_in_at: string;
  members: {
    name: string;
  } | null;
}

export default function FaithIDAdminDashboard() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // 상태 관리
  const [activeMenu, setActiveMenu] = useState<'register' | 'members' | 'attendance'>('register');
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [statusMessage, setStatusMessage] = useState('AI 엔진을 깨우는 중입니다...');
  const [name, setName] = useState('');
  const [currentDescriptor, setCurrentDescriptor] = useState<number[] | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);
  
  // 데이터 목록 상태
  const [members, setMembers] = useState<MemberType[]>([]);
  const [attendanceLogs, setAttendanceLogs] = useState<AttendanceLogType[]>([]);

  // 1. 초기화: AI 모델 로드 및 데이터 바인딩
  useEffect(() => {
    async function initAdmin() {
      const MODEL_URL = '/models';
      try {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        setModelsLoaded(true);
        setStatusMessage('✨ FaithID 어드민 시스템 구동 중');
        
        // 데이터 선행 로드
        fetchMembers();
        fetchTodayAttendance();
      } catch (error) {
        console.error(error);
        setStatusMessage('초기화 실패. 파일이나 DB 설정을 확인하세요.');
      }
    }
    initAdmin();
  }, []);

  // [데이터 조회] 전체 성도 명단 가져오기
  async function fetchMembers() {
    const { data, error } = await supabase
      .from('members')
      .select('id, name, created_at')
      .order('created_at', { ascending: false });
    if (!error && data) setMembers(data as MemberType[]);
  }

  // [데이터 조회] 오늘 출석 현황 가져오기 📍
  async function fetchTodayAttendance() {
    const today = new Date();
    today.setHours(0, 0, 0, 0); // 오늘 시작 시간 (00:00:00)

    // attendance_log를 가져오면서 해당 로그를 찍은 member의 name까지 관계형(Join) 조회합니다.
    const { data, error } = await supabase
      .from('attendance_log')
      .select(`
        id,
        checked_in_at,
        members ( name )
      `)
      .gte('checked_in_at', today.toISOString()) // 오늘 00시 이후 데이터만 필터링
      .order('checked_in_at', { ascending: false });

    if (!error && data) {
      setAttendanceLogs(data as unknown as AttendanceLogType[]);
    }
  }

  // 2. 카메라 제어 (등록 메뉴일 때만 카메라 구동되도록 제어)
  useEffect(() => {
    if (!modelsLoaded || activeMenu !== 'register') return;

    let currentStream: MediaStream | null = null;

    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480 } })
      .then((stream) => {
        currentStream = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => setStatusMessage('카메라를 켤 수 없습니다.'));

    // 다른 메뉴로 이동 시 카메라 스트림을 꺼서 기기 자원 확보
    return () => {
      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [modelsLoaded, activeMenu]);

  // 3. 실시간 얼굴 인식 엔진 루프 (등록 탭 전용)
  const handleVideoPlay = () => {
    if (!videoRef.current || !canvasRef.current) return;

    const displaySize = { width: 640, height: 480 };
    faceapi.matchDimensions(canvasRef.current, displaySize);

    const intervalId = setInterval(async () => {
      if (!videoRef.current || !canvasRef.current || activeMenu !== 'register') return;

      const detection = await faceapi
        .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks(true)
        .withFaceDescriptor();

      const context = canvasRef.current.getContext('2d');
      if (context) context.clearRect(0, 0, displaySize.width, displaySize.height);

      if (detection) {
        const resizedDetection = faceapi.resizeResults(detection, displaySize);
        faceapi.draw.drawDetections(canvasRef.current, resizedDetection);
        setCurrentDescriptor(Array.from(detection.descriptor));
      } else {
        setCurrentDescriptor(null);
      }
    }, 100);

    return () => clearInterval(intervalId);
  };

  // 4. 성도 등록 기능
  const handleRegister = async () => {
    if (!name.trim()) return alert('이름을 입력해주세요.');
    if (!currentDescriptor) return alert('얼굴이 인식되지 않았습니다.');

    setIsRegistering(true);
    try {
      const { error } = await supabase.from('members').insert([
        { name: name, face_descriptor: currentDescriptor },
      ]);
      if (error) throw error;

      alert(`🎉 ${name} 성도님이 등록되었습니다!`);
      setName('');
      fetchMembers(); // 명단 갱신
    } catch (error) {
      console.error(error);
      alert('등록 오류 발생');
    } finally {
      setIsRegistering(false);
    }
  };

  // 5. 성도 삭제 기능
  const handleDeleteMember = async (id: string, memberName: string) => {
    if (!confirm(`정말로 ${memberName} 성도님을 삭제하시겠습니까?`)) return;
    const { error } = await supabase.from('members').delete().eq('id', id);
    if (!error) {
      alert('삭제되었습니다.');
      fetchMembers();
      fetchTodayAttendance(); // 출석 현황도 같이 동기화
    }
  };

  // 특정 탭으로 이동할 때 데이터를 최신화하는 함수
  const handleMenuChange = (menu: 'register' | 'members' | 'attendance') => {
    setActiveMenu(menu);
    if (menu === 'members') fetchMembers();
    if (menu === 'attendance') fetchTodayAttendance();
  };

  return (
    <div className="flex flex-col md:flex-row min-h-screen bg-gray-900 text-white">
      
      {/* 🧭 좌측 네비게이션 메뉴바 */}
      <aside className="w-full md:w-64 bg-gray-950 border-r border-gray-800 p-6 flex flex-col justify-between">
        <div>
          <div className="mb-8">
            <h1 className="text-2xl font-black text-indigo-400 tracking-tight">💡 FaithID Admin</h1>
            <p className="text-xs text-gray-500 mt-1">{statusMessage}</p>
          </div>
          
          <nav className="flex flex-col gap-2">
            <button
              onClick={() => handleMenuChange('register')}
              className={`w-full text-left px-4 py-3 rounded-xl font-bold transition-all ${
                activeMenu === 'register' ? 'bg-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
              }`}
            >
              📸 신규 성도 등록
            </button>
            <button
              onClick={() => handleMenuChange('members')}
              className={`w-full text-left px-4 py-3 rounded-xl font-bold transition-all ${
                activeMenu === 'members' ? 'bg-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
              }`}
            >
              👥 등록 성도 관리
            </button>
            <button
              onClick={() => handleMenuChange('attendance')}
              className={`w-full text-left px-4 py-3 rounded-xl font-bold transition-all ${
                activeMenu === 'attendance' ? 'bg-indigo-600 text-white shadow-lg' : 'text-gray-400 hover:bg-gray-900 hover:text-gray-200'
              }`}
            >
              📊 오늘 출석 현황
            </button>
          </nav>
        </div>
        
        <footer className="text-xs text-gray-600 pt-4 border-t border-gray-800/50">
          © 2026 FaithID System.
        </footer>
      </aside>

      {/* 🖥️ 우측 메인 콘텐츠 영역 (선택된 메뉴에 따라 유연하게 바뀜) */}
      <main className="flex-1 p-8 bg-gray-900 overflow-y-auto">
        
        {/* 1) 신규 성도 등록 탭 */}
        {activeMenu === 'register' && (
          <div className="flex flex-col items-center max-w-2xl mx-auto">
            <h2 className="text-2xl font-bold text-gray-200 self-start mb-6">신규 성도 인롤먼트</h2>
            <div className="relative w-full aspect-[4/3] border-4 border-indigo-500 rounded-2xl overflow-hidden shadow-2xl bg-black mb-6">
              <video ref={videoRef} autoPlay muted onPlay={handleVideoPlay} className="absolute top-0 left-0 w-full h-full object-cover" />
              <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />
            </div>
            <div className="flex flex-col sm:flex-row gap-3 w-full bg-gray-800 p-4 rounded-xl border border-gray-700">
              <input
                type="text"
                placeholder="성도 이름 입력"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isRegistering}
                className="flex-1 px-4 py-3 bg-gray-950 border border-gray-600 rounded-lg focus:outline-none focus:border-indigo-400"
              />
              <button
                onClick={handleRegister}
                disabled={isRegistering || !currentDescriptor}
                className={`px-6 py-3 font-bold rounded-lg transition-all ${
                  currentDescriptor && !isRegistering ? 'bg-indigo-500 hover:bg-indigo-600' : 'bg-gray-600 text-gray-400 cursor-not-allowed'
                }`}
              >
                {isRegistering ? '등록 중...' : '얼굴 등록'}
              </button>
            </div>
          </div>
        )}

        {/* 2) 등록 성도 관리 탭 */}
        {activeMenu === 'members' && (
          <div className="bg-gray-800 p-6 rounded-2xl border border-gray-700 max-w-4xl mx-auto">
            <h2 className="text-2xl font-bold text-indigo-300 mb-6 flex justify-between items-center">
              👥 등록 성도 총괄 관리
              <span className="text-sm font-normal text-gray-400">교회 등록 인원: {members.length}명</span>
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-gray-700 text-gray-400 text-sm">
                    <th className="pb-3 pl-2">성도 번호(ID)</th>
                    <th className="pb-3">이름</th>
                    <th className="pb-3">최초 등록일</th>
                    <th className="pb-3 text-right pr-2">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => (
                    <tr key={member.id} className="border-b border-gray-700/40 hover:bg-gray-750/30">
                      <td className="py-3 pl-2 text-xs font-mono text-gray-500">{member.id.substring(0, 8)}...</td>
                      <td className="py-3 font-medium text-gray-200">{member.name}</td>
                      <td className="py-3 text-sm text-gray-400">{new Date(member.created_at).toLocaleDateString('ko-KR')}</td>
                      <td className="py-3 text-right pr-2">
                        <button
                          onClick={() => handleDeleteMember(member.id, member.name)}
                          className="px-3 py-1 text-xs bg-red-950 text-red-400 border border-red-900/50 rounded hover:bg-red-900/50"
                        >
                          데이터 파기
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 3) 오늘 출석 현황 탭 📍 */}
        {activeMenu === 'attendance' && (
          <div className="bg-gray-800 p-6 rounded-2xl border border-gray-700 max-w-4xl mx-auto">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h2 className="text-2xl font-bold text-emerald-400">📊 오늘 예배 출석 현황</h2>
                <p className="text-xs text-gray-400 mt-1">오늘 자정 이후 기록된 실시간 출석 기록입니다.</p>
              </div>
              <div className="bg-gray-900 border border-gray-700 px-4 py-2 rounded-xl text-center">
                <span className="text-xs text-gray-400 block">오늘 온 사람</span>
                <span className="text-xl font-black text-emerald-400">{attendanceLogs.length}명</span>
              </div>
            </div>

            <div className="overflow-x-auto">
              {attendanceLogs.length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  📥 아직 오늘 출석 기록이 없습니다.<br/>메인 로비 태블릿에서 체크인을 진행해 주세요.
                </div>
              ) : (
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-b border-gray-700 text-gray-400 text-sm">
                      <th className="pb-3 pl-2">출석 번호</th>
                      <th className="pb-3">성도 이름</th>
                      <th className="pb-3">인증 시각(체크인)</th>
                      <th className="pb-3 text-right pr-2">상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendanceLogs.map((log, index) => (
                      <tr key={log.id} className="border-b border-gray-700/40 hover:bg-gray-750/30">
                        <td className="py-3 pl-2 text-xs font-mono text-gray-500">{attendanceLogs.length - index}</td>
                        <td className="py-3 font-semibold text-gray-100">
                          {log.members?.name || '탈퇴 혹은 삭제된 성도'}
                        </td>
                        <td className="py-3 text-sm text-gray-300">
                          {new Date(log.checked_in_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </td>
                        <td className="py-3 text-right pr-2">
                          <span className="px-2 py-0.5 text-xs rounded-md bg-emerald-950 text-emerald-400 border border-emerald-900/60 font-medium">
                            출석 확인
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

      </main>
    </div>
  );
}