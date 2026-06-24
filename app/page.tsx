'use client';

import { useEffect, useRef, useState } from 'react';
import * as faceapi from 'face-api.js';
import { supabase } from './supabase';

interface MemberType {
  id: string;
  name: string;
  face_descriptor: number[];
}

export default function FaithIDAttendancePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [dbMembers, setDbMembers] = useState<MemberType[]>([]);
  const [statusMessage, setStatusMessage] = useState('AI 엔진을 깨우는 중입니다...');
  
  // 최근에 출석 체크 성공한 사람 이름과 시간 기억 (중복 출석 방지 및 화면 표시용)
  const [lastCheckedName, setLastCheckedName] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const checkedUsersRef = useRef<Record<string, number>>({}); // { userId: timestamp }

  // 1. AI 모델 로드 및 Supabase에서 등록된 성도 전체 명단(특징점) 가져오기
  useEffect(() => {
    const initFaithID = async () => {
      try {
        // AI 모델 로드
        const MODEL_URL = '/models';
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);

        // DB에서 기존 성도들의 이름과 얼굴 벡터 목록 다운로드
        const { data, error } = await supabase.from('members').select('id, name, face_descriptor');
        if (error) throw error;

        setDbMembers(data as MemberType[]);
        setModelsLoaded(true);
        setStatusMessage('✨ FaithID 구동 중... 카메라를 바라보면 자동으로 출석됩니다.');
      } catch (error) {
        console.error(error);
        setStatusMessage('초기화 실패. DB 연결이나 모델 파일을 확인하세요.');
      }
    };
    initFaithID();
  }, []);

  // 2. 카메라 시작
  useEffect(() => {
    if (!modelsLoaded) return;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480 } })
      .then((stream) => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      })
      .catch(() => setStatusMessage('카메라를 켤 수 없습니다.'));
  }, [modelsLoaded]);

  // 3. 실시간 얼굴 대조 및 자동 출석 루프
  const handleVideoPlay = () => {
    if (!videoRef.current || !canvasRef.current || dbMembers.length === 0) return;

    const displaySize = { width: 640, height: 480 };
    faceapi.matchDimensions(canvasRef.current, displaySize);

    // 수많은 성도 벡터 중 가장 비슷한 사람을 찾아내는 face-api.js의 매처(Matcher) 생성
    // 0.45는 거리(Distance) 임계값으로, 숫자가 낮을수록 엄격하게(똑같아야만) 판별합니다. (기본값 추천)
    const labeledDescriptors = dbMembers.map(m => 
      new faceapi.LabeledFaceDescriptors(m.id, [new Float32Array(m.face_descriptor)])
    );
    const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.45);

    const intervalId = setInterval(async () => {
      if (!videoRef.current || !canvasRef.current) return;

      const detection = await faceapi
        .detectSingleFace(videoRef.current, new faceapi.TinyFaceDetectorOptions())
        .withFaceLandmarks(true)
        .withFaceDescriptor();

      const context = canvasRef.current.getContext('2d');
      if (context) context.clearRect(0, 0, displaySize.width, displaySize.height);

      if (detection) {
        const resizedDetection = faceapi.resizeResults(detection, displaySize);
        
        // 캔버스에 사각형 그리기
        faceapi.draw.drawDetections(canvasRef.current, resizedDetection);

        // 현재 카메라에 잡힌 얼굴이 DB의 누구와 가장 매칭되는지 계산
        const bestMatch = faceMatcher.findBestMatch(detection.descriptor);
        const memberId = bestMatch.label; // 매칭된 유저의 id (찾지 못하면 "unknown")

        if (memberId !== 'unknown') {
          const matchedMember = dbMembers.find(m => m.id === memberId);
          if (matchedMember) {
            const now = Date.now();
            const lastCheckedTime = checkedUsersRef.current[memberId] || 0;

            // 💡 동일 인물이 연속으로 계속 출석 찍히는 것 방지 (1분 제한 쿨타임)
            if (now - lastCheckedTime > 60000) {
              checkedUsersRef.current[memberId] = now; // 쿨타임 갱신
              
              // 출석 성공 처리 연산 함수 호출
              logAttendance(matchedMember);
            }
          }
        }
      }
    }, 200); // 대조 작업은 연산량이 있으므로 0.2초 주기가 적당합니다.

    return () => clearInterval(intervalId);
  };

  // 4. Supabase에 출석 기록 박기
  const logAttendance = async (member: MemberType) => {
    try {
      const { error } = await supabase.from('attendance_log').insert([
        { member_id: member.id }
      ]);
      if (error) throw error;

      setLastCheckedName(member.name);
      setAlertMessage(`🎉 ${member.name} 성도님, 출석 완료! 반갑습니다.`);
      
      // 3초 뒤에 축하 메시지 슬며시 지우기
      setTimeout(() => setAlertMessage(''), 3000);
    } catch (err) {
      console.error('출석 기록 실패:', err);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-900 text-white p-4">
      <header className="text-center mb-6">
        <h1 className="text-4xl font-extrabold text-indigo-400 tracking-tight mb-2">FaithID</h1>
        <p className="text-xl font-medium text-emerald-400 h-8">{alertMessage || statusMessage}</p>
      </header>

      <div className="relative w-[640px] h-[480px] border-4 border-emerald-500 rounded-2xl overflow-hidden shadow-2xl bg-black mb-6">
        <video ref={videoRef} autoPlay muted onPlay={handleVideoPlay} className="absolute top-0 left-0 w-full h-full object-cover" />
        <canvas ref={canvasRef} className="absolute top-0 left-0 w-full h-full pointer-events-none" />
      </div>

      {/* 최근 출석자 현황판 */}
      {lastCheckedName && (
        <div className="w-[640px] bg-gray-800 p-4 rounded-xl text-center border border-emerald-600 animate-pulse">
          <p className="text-gray-300 text-sm">최근 통과자</p>
          <p className="text-2xl font-bold text-white mt-1">✨ {lastCheckedName} 성도님</p>
        </div>
      )}
    </div>
  );
}